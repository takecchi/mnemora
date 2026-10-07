import { sql, type SQL } from "drizzle-orm";
import type {
  Ctx,
  EmbeddingSpaceId,
  EraseTenantResult,
  EraseTenantStoreOptions,
  MemoryId,
  VectorEntry,
  VectorFilter,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import {
  assertWellFormedCtx,
  assertWellFormedFilter,
  EmbeddingSpaceNotRegisteredError,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { omitParamsFromError, omittingParams } from "./omit-params.js";
import { lockTenantForErase } from "./erase-tenant-lock.js";
import { listEmbeddingSpaceTables } from "./embedding-space-catalog.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";
import { isUuidLike, normalizeUuidCase, toPgTimestampClamped } from "./mapping.js";
import { maybeAnalyzeAfterUpsert } from "./embedding-statistics.js";
import { activityFloorSeqAliveCondition } from "./activity-decay-sql.js";
import { assertSafeSchemaName } from "./schema-namespace.js";
import {
  PGVECTOR_CAPABILITY_QUERY,
  type PgvectorCapabilityRow,
  assertPgvectorCapabilityRow,
} from "./pgvector-capability.js";
import { assertFloat4Vector, assertNoNulInScopeFilter, fitsFloat4 } from "./input-check.js";

function memoryNotFound(id: string): Error {
  return new Error(`PostgresVectorStore: memory not found for tenant: ${id}`);
}

/** `number[]` を pgvector のテキスト表現（`[1,2,3]`）に変換する。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * `search`/`searchMany` のクエリを、pgvector が受け取れて比較の結果が意味を持つ形にする。
 * 比較不能なクエリ（長さが `space.dimensions` と違う・空配列・float4 に収まらない成分・有限でない成分を含む）は、
 * `space.dimensions` 長の全 0 ベクトルに差し替える。ゼロベクトルは ADR 0040 の経路（`<=>` が `NaN` を返す）に乗り、
 * `recall()` の段2で `score_not_comparable` に数えられる。新しい throw は足さない（投げるのは `upsert` だけ）。
 * pgvector は、これらを未捕捉の `DrizzleQueryError` で拒むため、core の `FakeVectorStore`・testkit の
 * `InMemoryVectorStore` が距離を `NaN` で返すのに揃える（ADR 0424）。
 */
function toComparableQuery(query: number[], dimensions: number): number[] {
  if (
    query.length !== dimensions ||
    !query.every((x) => Number.isFinite(x)) ||
    !fitsFloat4(query)
  ) {
    return new Array(dimensions).fill(0);
  }
  return query;
}

/** `toVectorLiteral` の逆——pgvector のテキスト表現（`[1,2,3]`）を `number[]` に戻す。 */
function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}

/**
 * `withRelaxedOrderScan` が使う、`PostgresVectorStore` インスタンスごとの pgvector 能力検査キャッシュ（ADR 0367）。
 * `search()`/`searchMany()` で共有する。
 *
 * **成功だけを覚える。失敗は覚えない**（次の呼び出しでまた検査する）。失敗を覚えても、`search()`/`searchMany()` が
 * 毎回失敗している状態のコストは下がらず、DBA が `ALTER EXTENSION vector UPDATE;` で直した後もプロセス再起動まで
 * 検査が固定されるだけになるため。
 */
class PgvectorCapabilityGate {
  private confirmed = false;

  async ensure(db: Db): Promise<void> {
    if (this.confirmed) {
      return;
    }
    // `sql.raw`: `PGVECTOR_CAPABILITY_QUERY` はパラメータを持たない固定文字列。
    const result = await db.execute(sql.raw(PGVECTOR_CAPABILITY_QUERY));
    assertPgvectorCapabilityRow(result.rows[0] as unknown as PgvectorCapabilityRow | undefined);
    this.confirmed = true;
  }
}

/**
 * `search()`/`searchMany()` の両方が使う、ADR 0284 の `SET LOCAL` を発行してから `run` を実行する共通ヘルパー。
 * **`hnsw.iterative_scan` を `relaxed_order` に変える `SET LOCAL` 文は、このファイルの中で下の実装1箇所にしか書かない。**
 * `hnsw-ef-search-window-ceiling.test.ts` 検査2 がソース走査で「1箇所だけ」を固定しているので、複製してはならない。
 *
 * `SET LOCAL` はトランザクション内でしか効かないので、`db.transaction()` で `BEGIN` してから発行する。
 *
 * `SET LOCAL` の**前**に、`capabilityGate` で pgvector がその値を解釈できることを確認する（ADR 0367）。0.8 未満では
 * 「初回だけ通り2回目から ERROR」または「黙って効かない」ので、対応していなければ `PgvectorVersionUnsupportedError` を
 * 投げて `SET LOCAL` を発行しない（`ann_truncated`/`ann_unreached` を静かに歪めるより、早く分かりやすく落とす）。
 */
async function withRelaxedOrderScan<T>(
  db: Db,
  capabilityGate: PgvectorCapabilityGate,
  run: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  await capabilityGate.ensure(db);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return run(tx);
  });
}

/**
 * `searchMany` が1文に入れるクエリの数（ADR 0443）。1クエリあたり 2 個のバインドパラメータを使うので、
 * 16384 × 2 = 32768 個と、ほかの固定のパラメータ（tenant・filter・limit）で、PG の上限 65535 に収まる。
 */
const SEARCH_MANY_CHUNK_SIZE = 16_384;

/**
 * `search()`/`searchMany()` の両方が使う、`m.*`（memories 側）だけの `WHERE` 条件の組み立て（ADR 0362）。
 * **`filter` の翻訳ロジックはこの1箇所だけに置く。**`e.tenant_id` 由来の条件はここに含まない
 * （呼び出し側がクエリの形ごとに組み立てる）。クエリベクトルは扱わない。
 */
function memoryOnlyConditions(filter: VectorFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.status !== undefined) {
    conditions.push(sql`m.status = ANY(${sql.param(filter.status)}::text[])`);
  }
  // 忘却ゲートの2軸。`decayFloorAnyAxis` が true かつ両方の境界が渡されているときだけ OR で結ぶ（ADR 0165）。
  const decayFloorAtCondition =
    filter.decayFloorAtAfter !== undefined
      ? sql`m.decay_floor_at > ${toPgTimestampClamped(filter.decayFloorAtAfter)}`
      : undefined;
  // `decay_floor_seq IS NULL` の行は通す（NULL は「活動時計では沈まない」）。`decayFloorSeqUsesSubjectCounters` が
  // true のときだけ、行の subject に対応する `tenant_subject_activity` を相関サブクエリで足す（ADR 0353）。
  const decayFloorSeqCondition = activityFloorSeqAliveCondition({
    decayFloorSeqAfter: filter.decayFloorSeqAfter,
    usesSubjectCounters: filter.decayFloorSeqUsesSubjectCounters === true,
    floorSeqExpr: sql`m.decay_floor_seq`,
    tenantIdExpr: sql`m.tenant_id`,
    subjectIdExpr: sql`m.subject_id`,
  });
  if (
    filter.decayFloorAnyAxis === true &&
    decayFloorAtCondition !== undefined &&
    decayFloorSeqCondition !== undefined
  ) {
    conditions.push(sql`(${decayFloorAtCondition} OR ${decayFloorSeqCondition})`);
  } else {
    if (decayFloorAtCondition !== undefined) {
      conditions.push(decayFloorAtCondition);
    }
    if (decayFloorSeqCondition !== undefined) {
      conditions.push(decayFloorSeqCondition);
    }
  }
  // `subjectId` が無ければこの欄自体を見ない（「テナント全体」は定義上すでに主題なしを含む）。
  if (filter.subjectId !== undefined) {
    conditions.push(
      filter.includeSubjectless === true
        ? sql`(m.subject_id = ${filter.subjectId} OR m.subject_id IS NULL)`
        : sql`m.subject_id = ${filter.subjectId}`,
    );
  }
  // `jsonb` の containment（`@>`）。`idx_memories_attributes`（`jsonb_path_ops`）が効く述語。
  if (filter.attributes !== undefined) {
    conditions.push(sql`m.attributes @> ${JSON.stringify(filter.attributes)}::jsonb`);
  }
  // 配列の重なり演算子（`&&`）。`idx_memories_tags`（GIN）が効く。
  if (filter.labels !== undefined) {
    conditions.push(sql`m.tags && ${sql.param(filter.labels)}::text[]`);
  }
  // 比較対象は COALESCE(occurred_at, recorded_at)（ADR 0039 の実効時刻）。両端とも包含（`>=`/`<=`）で、
  // `memory-store.ts` の `aggregateScope` と同じ境界に揃える。
  if (filter.occurredAfter !== undefined) {
    conditions.push(
      sql`COALESCE(m.occurred_at, m.recorded_at) >= ${toPgTimestampClamped(filter.occurredAfter)}`,
    );
  }
  if (filter.occurredBefore !== undefined) {
    conditions.push(
      sql`COALESCE(m.occurred_at, m.recorded_at) <= ${toPgTimestampClamped(filter.occurredBefore)}`,
    );
  }
  // 両端 NULL は「いつでも真」。`valid_until` は狭義の `>`（`decayFloorAtAfter` と同じ境界の向き）。
  if (filter.validAt !== undefined) {
    conditions.push(
      sql`(m.valid_from IS NULL OR m.valid_from <= ${toPgTimestampClamped(filter.validAt)}) AND (m.valid_until IS NULL OR m.valid_until > ${toPgTimestampClamped(filter.validAt)})`,
    );
  }
  // 空配列は no-op。`length > 0` で番わないと、常に真の `<> ALL('{}')` が出て `EXPLAIN` を読みにくくする（ADR 0056）。
  if (filter.excludeProvenanceKinds !== undefined && filter.excludeProvenanceKinds.length > 0) {
    conditions.push(
      sql`m.provenance_kind <> ALL(${sql.param(filter.excludeProvenanceKinds)}::text[])`,
    );
  }
  return conditions;
}

/**
 * `search()` が使う `WHERE` 条件の組み立て。`e.tenant_id` の2条件を先頭に置き、`memoryOnlyConditions` を連ねる。
 *
 * テナントは `filter.tenantId` と `ctx.tenantId` の**両方**で絞る（AND）。隔離の境界は `ctx.tenantId` で（ADR 0007）、
 * `filter.tenantId` だけだと、食い違ったとき `filter` 側のテナントの行が返る。食い違えば0件で、例外は投げない。
 */
function buildFilterConditions(ctx: Ctx, filter: VectorFilter) {
  const conditions = [
    sql`e.tenant_id = ${filter.tenantId}`,
    sql`e.tenant_id = ${ctx.tenantId}`,
    ...memoryOnlyConditions(filter),
  ];
  return sql.join(conditions, sql` AND `);
}

/**
 * `searchMany` 専用（ADR 0362）。`search()` の `JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id` は、
 * `searchMany` では `CROSS JOIN LATERAL (SELECT * FROM memories WHERE id = e.memory_id OFFSET 0) m` に置き換わる。
 * `JOIN ... ON` が無いので、テナント境界（`m.tenant_id = e.tenant_id`）はこの関数が明示的に足す。
 * **これが無いと、統計の有無に関係なく他テナントの行が漏れうる。**
 *
 * `m.tenant_id = e.tenant_id` は **LATERAL の中ではなく外側の `WHERE` に置く**。中に足すと、プランナが
 * `memories_pkey` 以外の索引（`tenant_id` を先頭に持つ `idx_memories_recall_gate_seq` 等）も候補にでき、統計が無い
 * 場面で実際にそちらを選んで `m` を主キーで引かなくなる。LATERAL の中身を `id = e.memory_id` **だけ**にして、
 * 候補になり得る索引を `memories_pkey` 一択にする。
 */
function buildLateralMemoryConditions(filter: VectorFilter) {
  const conditions = [sql`m.tenant_id = e.tenant_id`, ...memoryOnlyConditions(filter)];
  return sql.join(conditions, sql` AND `);
}

/** `search()`/`searchMany()` の両方が使う `e` 側の `WHERE` 条件（統計が無い場面の枝で使う。`m` 側は `buildLateralMemoryConditions`）。 */
function buildEmbeddingConditions(ctx: Ctx, filter: VectorFilter) {
  return sql`e.tenant_id = ${filter.tenantId} AND e.tenant_id = ${ctx.tenantId}`;
}

/**
 * `search()`/`searchMany()` の両方が使う、**統計がある場面**の2枝（`vector_norm > 0`/`= 0`）の `UNION ALL`。
 * `memories` を素の `JOIN` で引く（ADR 0374）。`distanceExpr` は距離演算子の右辺（`search()` ではリテラル、
 * `searchMany()` では `LATERAL` の外側の列 `q.qvec`）。
 */
function buildStatsPresentBranches(
  table: string,
  whereClause: SQL,
  distanceExpr: SQL,
  limit: number,
) {
  return sql`
    (
      SELECT e.memory_id AS memory_id, e.embedding <=> ${distanceExpr} AS distance,
             m.recorded_at AS recorded_at
      FROM ${sql.identifier(table)} e
      JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
      WHERE ${whereClause} AND vector_norm(e.embedding) > 0
      ORDER BY e.embedding <=> ${distanceExpr}, m.recorded_at DESC, e.memory_id
      LIMIT ${limit}
    )
    UNION ALL
    (
      SELECT e.memory_id AS memory_id, e.embedding <=> ${distanceExpr} AS distance,
             m.recorded_at AS recorded_at
      FROM ${sql.identifier(table)} e
      JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
      WHERE ${whereClause} AND vector_norm(e.embedding) = 0
      ORDER BY m.recorded_at DESC, e.memory_id
      LIMIT ${limit}
    )
  `;
}

/**
 * `search()`/`searchMany()` の両方が使う、**統計が無い場面**の2枝の `UNION ALL`。`memories` を主キーで引く
 * （ADR 0362・0374）。`LATERAL` の中身は `id = e.memory_id` だけ、`OFFSET 0` は最適化の柵、テナント境界は柵の外。
 */
function buildStatsMissingBranches(
  table: string,
  embeddingConditions: SQL,
  memoryConditions: SQL,
  distanceExpr: SQL,
  limit: number,
) {
  return sql`
    (
      SELECT e.memory_id AS memory_id, e.embedding <=> ${distanceExpr} AS distance,
             m.recorded_at AS recorded_at
      FROM ${sql.identifier(table)} e
      CROSS JOIN LATERAL (
        SELECT * FROM memories WHERE id = e.memory_id OFFSET 0
      ) m
      WHERE ${embeddingConditions} AND vector_norm(e.embedding) > 0 AND ${memoryConditions}
      ORDER BY e.embedding <=> ${distanceExpr}, m.recorded_at DESC, e.memory_id
      LIMIT ${limit}
    )
    UNION ALL
    (
      SELECT e.memory_id AS memory_id, e.embedding <=> ${distanceExpr} AS distance,
             m.recorded_at AS recorded_at
      FROM ${sql.identifier(table)} e
      CROSS JOIN LATERAL (
        SELECT * FROM memories WHERE id = e.memory_id OFFSET 0
      ) m
      WHERE ${embeddingConditions} AND vector_norm(e.embedding) = 0 AND ${memoryConditions}
      ORDER BY m.recorded_at DESC, e.memory_id
      LIMIT ${limit}
    )
  `;
}

/**
 * `memories`・埋め込み表の統計（`pg_class.reltuples`）が両方とも「一度は `ANALYZE`/`VACUUM` された」（`>= 0`）ことを、
 * `PostgresVectorStore` のインスタンス・表ごとに一度だけ確かめ、以後は確かめ直さない（ADR 0374）。
 *
 * - **表ごと**: 埋め込み表は空間ごとに別の物理テーブル（`memory_embeddings_<space>`）で、ある空間が統計を持っても
 *   別の空間は持たないことがある。`memories` は共有1テーブルなので表名を持たない特別な1エントリとして覚える。
 * - **インスタンスごと**（モジュールの大域変数・`static` にしない）: 複数のインスタンスが在るとき、片方が確認済み
 *   でももう片方は別に確認する。共有すると、覚え間違いをテストで検出できなくなる。
 * - **テナントごとには持たない**: 統計は表単位の情報で、`reltuples` はテナントを区別しない。
 *
 * **一度 `true` を覚えたら、そのインスタンスの寿命の間ずっと `true` のまま。**統計が後で消えても（`TRUNCATE`・表の
 * 作り直し等）確認し直さない。結果は変わらず、遅くなるだけ（統計が無いのに「ある」前提の SQL を送り、直す前のプランに
 * 戻りうる）。この代償は受け入れた（ADR 0374）。
 *
 * 一度も `ANALYZE`/`VACUUM` されていない表は `reltuples` が負（`-1`。PostgreSQL 14 以降。ADR 0062）になる。
 * `to_regclass` は search_path 経由でテーブルを解決する（識別子ではなくテキストのパラメータとして渡す）。
 */
class StatsPresenceGate {
  /** 表名（`memories` は固定の特別なキー）ごとに、確認済み（`reltuples >= 0`）かどうか。 */
  private readonly confirmed = new Set<string>();

  /** 両方が確認済みなら往復を発生させずに `true`。どちらかが未確認なら、1回の往復で両方の `reltuples` を読み、`>= 0` だったものだけを確認済みにする。 */
  async bothPresent(db: Db, table: string): Promise<boolean> {
    if (this.confirmed.has(table) && this.confirmed.has("memories")) {
      return true;
    }
    const result = await db.execute(sql`
      SELECT
        (SELECT reltuples FROM pg_class WHERE oid = to_regclass(${table})) AS embedding_reltuples,
        (SELECT reltuples FROM pg_class WHERE oid = to_regclass('memories')) AS memories_reltuples
    `);
    const row = result.rows[0] as unknown as {
      embedding_reltuples: string | number;
      memories_reltuples: string | number;
    };
    if (Number(row.embedding_reltuples) >= 0) {
      this.confirmed.add(table);
    }
    if (Number(row.memories_reltuples) >= 0) {
      this.confirmed.add("memories");
    }
    return this.confirmed.has(table) && this.confirmed.has("memories");
  }
}

/**
 * 空間の索引の表が無い（SQLSTATE 42P01 `undefined_table`）ときだけ、{@link EmbeddingSpaceNotRegisteredError} に包む
 * （ADR 0433）。原因の Error は `cause` に残す。`cause` の連鎖のどこかが `code === "42P01"` で、message がこの空間の
 * 表名の `does not exist` を指しているときだけ包む。別の表（`memories` など）が無いときの 42P01 は包まない。
 */
async function translateUnregisteredSpace<T>(
  space: EmbeddingSpaceId,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUndefinedTableError(error, embeddingSpaceTableName(space))) {
      // `cause` に残る drizzle の例外から、params の値（ベクトルなど）を落とす（ADR 0504）。
      throw new EmbeddingSpaceNotRegisteredError(space, { cause: omitParamsFromError(error) });
    }
    throw omitParamsFromError(error);
  }
}

function isUndefinedTableError(error: unknown, table: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, message, cause } = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      code === "42P01" &&
      typeof message === "string" &&
      message.includes(`${table}" does not exist`)
    ) {
      return true;
    }
    current = cause;
  }
  return false;
}

/**
 * `VectorStore` の Postgres 実装（pgvector）。`MemoryStore` が真実の源で、`VectorStore` は再構築可能な派生索引に留まる
 * （ADR 0003）。
 *
 * `search` の `ORDER BY` には距離演算子の結果をそのまま昇順で書く（式にしない）。docs/memory-model.md §10「規約」で、
 * `EXPLAIN` 検査の対象そのものである。
 *
 * **tie-break は3段**（ADR 0170）: (1) 距離、(2) `m.recorded_at` 降順、(3) `e.memory_id`。`memory_id` は ingest ごとの
 * ランダムな UUID で、DB を作り直す（fresh ingest）と勝者が変わるので、テナントの処理順に紐づく `recorded_at` を
 * 第2キーにして、fresh ingest をまたいでも相対順序が再現するようにする。`memory_id` は `recorded_at` まで完全一致した
 * ときだけ効く最終フォールバックで、その行どうしの間でだけ順序が ingest ごとに変わりうる。
 * **3段を足しても「タイが起こらない」ことは保証しない。**保証するのは「`recorded_at` が競合しない限り、fresh ingest を
 * またいで順序が再現する」ことだけである。
 *
 * テーブルは事前に `registerEmbeddingSpace`（`./vector-space.ts`）で作られている前提。未登録の空間に対して `upsert`・
 * `search`・`searchMany`・`delete`・`getVectors` を呼ぶと `EmbeddingSpaceNotRegisteredError`
 * （`kind: "embedding_space_not_registered"`、原因の `relation does not exist`（42P01）は `cause`）になる（ADR 0433）。
 * 形式不正な id だけの `delete`・`getVectors` と空の `searchMany` は空間を引かないので、未登録でも例外にならない。
 */
export class PostgresVectorStore implements VectorStore {
  private readonly pgvectorCapabilityGate = new PgvectorCapabilityGate();
  private readonly statsPresenceGate = new StatsPresenceGate();

  constructor(private readonly db: Db) {}

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // float4 に収まらない成分は、DB に触れる前に明示の例外で断る（ADR 0424）。
    assertFloat4Vector("PostgresVectorStore.upsert", vector);
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    // 記憶が `ctx.tenantId` のものであることを、書く前に確かめる（ADR 0436）。確かめと書き込みは1つの SQL 文（CTE）。
    // 検査で落ちたかは、`ON CONFLICT DO UPDATE` の行数ではなく戻り値の `ok`（検査の結果そのもの）で見る。
    const id = normalizeUuidCase(memoryId);
    if (!isUuidLike(id)) {
      throw memoryNotFound(id);
    }
    const result = await translateUnregisteredSpace(space, () =>
      this.db.execute(sql`
        WITH mem AS (
          SELECT EXISTS (
            SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          ) AS ok
        ),
        ins AS (
          INSERT INTO ${sql.identifier(table)} (tenant_id, memory_id, embedding, model, created_at)
          SELECT ${ctx.tenantId}, ${id}::uuid, ${toVectorLiteral(vector)}::vector, ${space.model}, now()
          FROM mem
          WHERE ok
          ON CONFLICT (tenant_id, memory_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, created_at = now()
        )
        SELECT ok FROM mem
      `),
    );
    if (!(result.rows[0] as unknown as { ok: boolean } | undefined)?.ok) {
      throw memoryNotFound(id);
    }
    // 統計が実態から遅れているときだけ ANALYZE を撃つ（ADR 0194）。判断は `embedding-statistics.ts` に集約している。
    void 0;
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    assertNoNulInScopeFilter("PostgresVectorStore.search", opts.filter, "opts.filter");
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    // 比較不能な `query` は全 0 ベクトルに差し替える（`toComparableQuery` の doc）。
    const effectiveQuery = toComparableQuery(query, space.dimensions);
    const queryLiteral = toVectorLiteral(effectiveQuery);

    const whereClause = buildFilterConditions(ctx, opts.filter);

    // ORDER BY には距離演算子の結果をそのまま昇順で置く（式にしない。docs/recall.md §3）。tie-break はクラス doc のとおり3段。
    //
    // `hnsw.iterative_scan` を `relaxed_order` にする `SET LOCAL` は、この SELECT だけを対象に `withRelaxedOrderScan`
    // が発行する（ADR 0284）。`SET LOCAL` の値はプレースホルダで束縛できないので固定のリテラルとして埋め込む。
    // `hnsw.max_scan_tuples` は既定のまま触らない。
    //
    // 下は2枝の `UNION ALL`（ADR 0343）。pgvector の cosine HNSW 索引は norm が0のベクトルを索引へ入れないので、
    // ORDER BY 押し下げの Index Scan だけに頼ると、ゼロベクトルの候補が ADR 0040 の契約（比較不能でも候補として返す）に
    // 反して消える。1枝目（`vector_norm(e.embedding) > 0`）は Index Scan（HNSW）に委ねる。ゼロベクトルの距離は常に
    // `NaN` で最後尾に落ちるので、`LIMIT ${opts.limit}` を超えて取る必要は無い。2枝目（`= 0`）は `registerEmbeddingSpace`
    // が作る部分索引（`WHERE vector_norm(embedding) = 0`）を使う。**2枝目にも `ORDER BY`/`LIMIT ${opts.limit}` を掛ける。**
    // 無いと、ゼロベクトルの行を大量に持つ空間で、その枝だけがテーブルの大きさに比例して増える。ゼロベクトルの距離は
    // すべて `NaN` で同点なので、`ORDER BY` は `recorded_at` DESC・`memory_id`（外側と同じ tie-break の続き）だけで揃える。
    // 外側の `SELECT` が両枝を距離→`recorded_at` DESC→`memory_id` へ並べ直して `LIMIT` を再適用する。
    //
    // 統計が確認済みなら `buildStatsPresentBranches` を、未確認のときだけ確認の往復を1回払い、必要なら候補D
    // （`buildStatsMissingBranches`）に切り替える（ADR 0374）。
    const statsPresent = await this.statsPresenceGate.bothPresent(this.db, table);
    const branches = statsPresent
      ? buildStatsPresentBranches(table, whereClause, sql`${queryLiteral}::vector`, opts.limit)
      : buildStatsMissingBranches(
          table,
          buildEmbeddingConditions(ctx, opts.filter),
          buildLateralMemoryConditions(opts.filter),
          sql`${queryLiteral}::vector`,
          opts.limit,
        );
    const result = await translateUnregisteredSpace(space, () =>
      withRelaxedOrderScan(this.db, this.pgvectorCapabilityGate, (tx) =>
        tx.execute(sql`
          SELECT combined.memory_id AS memory_id, combined.distance AS distance
          FROM (
            ${branches}
          ) AS combined
          ORDER BY combined.distance, combined.recorded_at DESC, combined.memory_id
          LIMIT ${opts.limit}
        `),
      ),
    );
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; distance: number };
      return { memoryId: r.memory_id, distance: r.distance };
    });
  }

  /**
   * `search()` を `queries.length` 回呼ぶのと同じ結果を、1回の往復に束ねる。契約は `VectorStore.searchMany?` の doc
   * （`filter`/`limit` は全クエリで共通、各クエリの結果は `search()` を単独で呼んだ場合と集合・順序が完全一致する）。
   *
   * **束ね方**: `VALUES` で `(query_idx, qvec)` の行を作り、各行に対して `LATERAL` で「その `qvec` を使った ANN 検索」を
   * 実行する。`m.*` 側の `filter` 翻訳は `search()` と同じ `memoryOnlyConditions` を共有する。
   *
   * **`memories` の引き方は `search()` と同じ仕組みで切り替える**（ADR 0374）。`statsPresenceGate` が「両方の統計が
   * 確認済み」なら `buildStatsPresentBranches`（素の `JOIN`）、未確認なら `buildStatsMissingBranches`（候補D。
   * `CROSS JOIN LATERAL (SELECT * FROM memories WHERE id = e.memory_id OFFSET 0) m` で `memories_pkey` を引かせる）を使う。
   * `OFFSET 0` はこの副問い合わせを外側へ引き上げず `e` の行ごとに独立して評価させる最適化の柵で、テナント境界
   * （`m.tenant_id = e.tenant_id`）は柵の**外**に置く（`buildLateralMemoryConditions` の doc）。
   * 統計が「未確認」の間だけ `reltuples` を読む往復が1回余分に掛かるが、アンカー数には依存せず、確認後は払わない。
   *
   * **統計の有無の判定を、このクエリの中でスカラー副問い合わせにして1本の `UNION ALL` に入れる形（ADR 0362）にしない。**
   * 統計がある場面でも `reltuples` を毎回読む分のプランナのコストを払い続け、`recall()` 全体で +5.06ms の悪化が出た
   * （ADR 0374）。
   *
   * **key は SQL に送らない**: `VALUES` にはクエリの添字（`0..n-1`）を送り、戻った行をそのクエリの key へ引き直す。
   * key を `text` のパラメータで送ると、NUL（U+0000）を含む key を Postgres が拒み、`search()` が投げない入力で
   * `searchMany` だけが投げる。
   *
   * **同じ key が2回以上あるときは、最後のクエリだけを送る**（`VectorStore.searchMany?` の契約）。`Map` の並びは、
   * 先に全部の key を `set` した順（最初に現れた位置）のまま。
   *
   * **`hnsw.iterative_scan` は `withRelaxedOrderScan` を経由して1回だけ効かせる。**`SET LOCAL` はトランザクション単位で、
   * `LATERAL` の繰り返しごとに再設定する必要は無い。この `SET LOCAL` 文をこのメソッドに複製しない
   * （`hnsw-ef-search-window-ceiling.test.ts` 検査2 が「`vector-store.ts` の中で1箇所だけ」を固定している）。
   */
  async searchMany(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    queries: { key: string; vector: number[] }[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<Map<string, VectorHit[]>> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    assertNoNulInScopeFilter("PostgresVectorStore.searchMany", opts.filter, "opts.filter");
    const resultMap = new Map<string, VectorHit[]>();
    // `queries` の `key` の集合は返り値の `Map` にそのまま現れる（結果が0件の key も欠落させない）。
    for (const q of queries) {
      resultMap.set(q.key, []);
    }
    if (queries.length === 0) {
      // 空配列なら往復を発生させずに空の Map を返す。
      return resultMap;
    }
    // 同じ key が2回以上あるときは、最後のクエリの結果だけを返す。それより前のクエリは SQL に送らない。
    const lastIndexByKey = new Map<string, number>();
    queries.forEach((q, index) => lastIndexByKey.set(q.key, index));
    const effectiveQueries = queries.filter((q, index) => lastIndexByKey.get(q.key) === index);

    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);

    const statsPresent = await this.statsPresenceGate.bothPresent(this.db, table);
    const distanceExpr = sql`q.qvec`;
    const branches = statsPresent
      ? buildStatsPresentBranches(
          table,
          buildFilterConditions(ctx, opts.filter),
          distanceExpr,
          opts.limit,
        )
      : buildStatsMissingBranches(
          table,
          buildEmbeddingConditions(ctx, opts.filter),
          buildLateralMemoryConditions(opts.filter),
          distanceExpr,
          opts.limit,
        );

    // `search()` と同じ比較不能の扱いを、クエリごとに独立して適用する。key ではなく添字を送る。
    const valuesRows = effectiveQueries.map((q, index) => {
      const effectiveQuery = toComparableQuery(q.vector, space.dimensions);
      return sql`(${index}::int, ${toVectorLiteral(effectiveQuery)}::vector)`;
    });

    // ADR 0443: `VALUES` は1クエリあたり 2 個のバインドパラメータを使うので、`SEARCH_MANY_CHUNK_SIZE` 件ずつに分けて
    // 同じトランザクションの中で1文ずつ撃つ（PG の上限 65535 に届かないように）。`LATERAL` の各行は独立なので、
    // 分けても集合・順序は変わらない。添字は全体の通し番号のまま送る。
    const rows = await translateUnregisteredSpace(space, () =>
      withRelaxedOrderScan(this.db, this.pgvectorCapabilityGate, async (tx) => {
        const collected: unknown[] = [];
        for (let start = 0; start < valuesRows.length; start += SEARCH_MANY_CHUNK_SIZE) {
          const chunk = valuesRows.slice(start, start + SEARCH_MANY_CHUNK_SIZE);
          const result = await tx.execute(sql`
            SELECT q.query_idx AS query_idx, hit.memory_id AS memory_id, hit.distance AS distance
            FROM (VALUES ${sql.join(chunk, sql`, `)}) AS q(query_idx, qvec)
            CROSS JOIN LATERAL (
              SELECT combined.memory_id AS memory_id, combined.distance AS distance
              FROM (
                ${branches}
              ) AS combined
              ORDER BY combined.distance, combined.recorded_at DESC, combined.memory_id
              LIMIT ${opts.limit}
            ) AS hit
          `);
          collected.push(...result.rows);
        }
        return collected;
      }),
    );
    for (const row of rows) {
      const r = row as { query_idx: number; memory_id: string; distance: number };
      resultMap
        .get(effectiveQueries[r.query_idx]!.key)
        ?.push({ memoryId: r.memory_id, distance: r.distance });
    }
    return resultMap;
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    // 形式が壊れた memoryId は、クエリを投げる前に no-op へ寄せる（DB 由来の `invalid input syntax for type uuid` を漏らさない）。
    if (!isUuidLike(memoryId)) {
      return;
    }
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    await translateUnregisteredSpace(space, () =>
      this.db.execute(sql`
        DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
      `),
    );
  }

  /**
   * `ctx.tenantId` に属する `memoryIds` の行を、この DB 接続が見ている `current_schema()` の中の**全 space**
   * （`memory_embeddings_<space>` テーブル全部）から消す（ADR 0382）。契約は `VectorStore.deleteAcrossSpaces` の doc。
   *
   * テーブルの列挙は {@link listEmbeddingSpaceTables}（`embedding-space-catalog.ts`）の3条件（`current_schema()` の中・
   * 名前が `memory_embeddings_` で始まる・`memory_id` が同じスキーマの `memories(id)` を外部キーで参照）で行う。
   * 無関係なテーブルを巻き込まないため。台帳は持たない（ADR 0002。space ごとに別テーブルなので、カタログを読めば列挙できる）。
   *
   * **`DELETE` はスキーマ修飾する（`search_path` に頼らない）。**列挙が返す `n.nspname` を使って
   * `${sql.identifier(schema)}.${sql.identifier(table)}` と完全修飾する。他のメソッドは未修飾で `search_path` に解決を
   * 任せるが、`current_schema()` は `search_path` の**先頭**を指すだけで、複数のスキーマを含む構成では、未修飾の
   * `DELETE` が解決するスキーマと列挙したスキーマがずれうる（同名のテーブルが2つのスキーマに在る場合）。
   * スキーマ名を明示して、「列挙で選んだテーブル」と「実際に `DELETE` するテーブル」を1対1に固定する。
   *
   * 列挙と削除は**1つのトランザクション**の中で行う。
   */
  async deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void> {
    assertWellFormedCtx(ctx);
    // `delete` と同じ規律。形式不正な id は「存在しない」の一種として、クエリを投げる前に落とす。空なら列挙のクエリも発行しない。
    const validIds = memoryIds.filter(isUuidLike);
    if (validIds.length === 0) {
      return;
    }
    await omittingParams(() =>
      this.db.transaction(async (tx) => {
        const tables = await listEmbeddingSpaceTables(tx);
        for (const { table, schema } of tables) {
          // `assertSafeIdentifier`/`assertSafeSchemaName` を通す（SQL 注入対策の最後の砦を他のメソッドと揃える）。
          assertSafeIdentifier(table);
          assertSafeSchemaName(schema);
          await tx.execute(sql`
          DELETE FROM ${sql.identifier(schema)}.${sql.identifier(table)}
          WHERE tenant_id = ${ctx.tenantId} AND memory_id = ANY(${sql.param(validIds)}::uuid[])
        `);
        }
      }),
    );
  }

  /**
   * `VectorStore.eraseTenant?` の実装（ADR 0383）。`deleteAcrossSpaces` と同じ列挙で全 space のテーブルを対象にし、
   * `memoryIds` の集合でなく `ctx.tenantId` の行を丸ごと消す。`opts.limit` は**全 space の合計**に対する budget として
   * 消費する（1つの space で使い切ってもよい。`MemoryStore.eraseTenant` の「保守的な近似」の `reachedLimit`）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun === true;
    return omittingParams(() =>
      this.db.transaction(async (tx) => {
        // 同じテナントへの同時呼び出しを直列にする（ADR 0430）。
        await lockTenantForErase(tx, ctx.tenantId);
        const tables = await listEmbeddingSpaceTables(tx);
        let remaining = opts.limit;
        let total = 0;
        let reachedLimit = false;
        for (const { table, schema } of tables) {
          if (remaining <= 0) {
            reachedLimit = true;
            break;
          }
          assertSafeIdentifier(table);
          assertSafeSchemaName(schema);
          const budget = remaining;
          let deleted: number;
          if (dryRun) {
            const result = await tx.execute(sql`
            SELECT count(*)::int AS count FROM (
              SELECT 1 FROM ${sql.identifier(schema)}.${sql.identifier(table)}
              WHERE tenant_id = ${ctx.tenantId} LIMIT ${budget}
            ) s
          `);
            deleted = (result.rows[0] as unknown as { count: number }).count;
          } else {
            const result = await tx.execute(sql`
            WITH victims AS (
              SELECT tenant_id, memory_id FROM ${sql.identifier(schema)}.${sql.identifier(table)}
              WHERE tenant_id = ${ctx.tenantId} LIMIT ${budget}
            )
            DELETE FROM ${sql.identifier(schema)}.${sql.identifier(table)} t
            USING victims v
            WHERE t.tenant_id = v.tenant_id AND t.memory_id = v.memory_id
            RETURNING t.memory_id
          `);
            deleted = result.rows.length;
          }
          total += deleted;
          remaining -= deleted;
          if (deleted === budget && deleted > 0) {
            reachedLimit = true;
            break;
          }
        }
        return { deleted: total, reachedLimit };
      }),
    );
  }

  async getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: MemoryId[],
  ): Promise<VectorEntry[]> {
    assertWellFormedCtx(ctx);
    // 形式不正な id は「存在しない」の一種として、クエリを投げる前に落とす（`delete` と同じ判断）。
    const validIds = memoryIds.filter(isUuidLike);
    if (validIds.length === 0) {
      return [];
    }
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    // tenant 境界を必ず掛ける。他テナントの memoryId が混ざっていても返さない。
    const result = await translateUnregisteredSpace(space, () =>
      this.db.execute(sql`
        SELECT memory_id AS memory_id, embedding::text AS embedding
        FROM ${sql.identifier(table)}
        WHERE tenant_id = ${ctx.tenantId} AND memory_id = ANY(${sql.param(validIds)}::uuid[])
      `),
    );
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; embedding: string };
      return { memoryId: r.memory_id, vector: parseVectorLiteral(r.embedding) };
    });
  }
}
