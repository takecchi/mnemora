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
import { assertWellFormedCtx, assertWellFormedFilter } from "@mnemora/core";
import type { Db } from "./client.js";
import { listEmbeddingSpaceTables } from "./embedding-space-catalog.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";
import { isUuidLike, toPgTimestamp } from "./mapping.js";
import { maybeAnalyzeAfterUpsert } from "./embedding-statistics.js";
import { activityFloorSeqAliveCondition } from "./activity-decay-sql.js";
import { assertSafeSchemaName } from "./schema-namespace.js";
import {
  PGVECTOR_CAPABILITY_QUERY,
  type PgvectorCapabilityRow,
  assertPgvectorCapabilityRow,
} from "./pgvector-capability.js";

/** `number[]` を pgvector のテキスト表現（`[1,2,3]`）に変換する。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * `search`/`searchMany` のクエリを、pgvector が受け取れて比較の結果が意味を持つ形にする。
 * 比較不能なクエリは `space.dimensions` 長の全 0 ベクトルに差し替える——ゼロベクトルは
 * ADR 0040 の経路（`<=>` が `NaN` を返す）に乗り、`recall()` の段2で
 * `score_not_comparable` に数えられる。新しい throw は足さない。
 *
 * 比較不能とするもの:
 * - 長さが `space.dimensions` と違う（空配列を含む。Issue #857・#867 の案B）
 * - 有限でない成分（`NaN`・`Infinity`・`-Infinity`）を含む。pgvector は
 *   「NaN not allowed in vector」／「infinite value not allowed in vector」で拒み、
 *   未捕捉の `DrizzleQueryError` になっていた。core の `FakeVectorStore` と testkit の
 *   `InMemoryVectorStore` は、この場合の距離を以前から `NaN` として返しており、それに揃える
 *   （歯は `__tests__/vector-search-non-finite-query.postgres.test.ts`）。
 */
function toComparableQuery(query: number[], dimensions: number): number[] {
  if (query.length !== dimensions || !query.every((x) => Number.isFinite(x))) {
    return new Array(dimensions).fill(0);
  }
  return query;
}

/** `toVectorLiteral` の逆——pgvector のテキスト表現（`[1,2,3]`）を `number[]` に戻す。 */
function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}

/**
 * `withRelaxedOrderScan` が使う、`PostgresVectorStore` インスタンスごとの pgvector 能力
 * 検査キャッシュ（Issue #1301、ADR 0367）。`search()`/`searchMany()` の両方から共有される
 * ——`PostgresVectorStore` のコンストラクタで1つ作り、両メソッドの `withRelaxedOrderScan`
 * 呼び出しへ渡す。
 *
 * **成功だけを覚える。失敗は覚えない**（次の呼び出しでまた検査する）。理由:
 * - 検査に対応している（`confirmed = true`）ことは、そのプロセスの寿命の間まず覆らない
 *   ——pgvector を「ダウングレードする」運用は通常無い。覚えて往復を省く価値がある。
 * - 検査に対応していない（現在エラーになっている）状態は、そもそも `search()`/
 *   `searchMany()` が毎回失敗しているため、失敗を覚えて省略しても定常状態のコストは
 *   下がらない——得るものが無いまま、DBA が `ALTER EXTENSION vector UPDATE;` を実行して
 *   直した後もプロセス再起動まで検査が固定されたままになる自己修復の悪い面だけが残る。
 *   ⟹ 失敗はキャッシュせず、直った瞬間に次の呼び出しが自然に成功へ倒れるようにする。
 */
class PgvectorCapabilityGate {
  private confirmed = false;

  async ensure(db: Db): Promise<void> {
    if (this.confirmed) {
      return;
    }
    // `sql.raw`: `PGVECTOR_CAPABILITY_QUERY` はパラメータを持たない固定文字列
    // （`pgvector-capability.ts` の doc 参照）——プレースホルダ化する動的な値は無い。
    const result = await db.execute(sql.raw(PGVECTOR_CAPABILITY_QUERY));
    assertPgvectorCapabilityRow(result.rows[0] as unknown as PgvectorCapabilityRow | undefined);
    this.confirmed = true;
  }
}

/**
 * `search()`/`searchMany()` の両方が使う、ADR 0284 の `SET LOCAL` を発行してから
 * `run` を実行する共通ヘルパー。**`hnsw.iterative_scan` を `relaxed_order` に変える
 * その `SET LOCAL` 文は、このファイルの中で下の実装1箇所にしか書かない**——
 * `search()`/`searchMany()` のどちらも直接 `SET LOCAL` を書かず、必ずこの関数を経由する。
 *
 * `packages/postgres/src/__tests__/hnsw-ef-search-window-ceiling.test.ts` 検査2
 * （ADR 0284）が「`hnsw.iterative_scan` を SET している箇所は `vector-store.ts` に
 * 1箇所だけ」をソース走査で固定している——`searchMany`（Issue #377）を足したときに
 * `search()` と同じ `SET LOCAL` 文をもう1箇所に複製すると、この歯が指摘する「1箇所」
 * という前提を壊す。共通ヘルパーへ抽出することで、複製せずに両メソッドから使い回す
 * （ADR 0284 追記参照——この抽出のあとも、ADR 0284 が測った「`search()` の正しさ・
 * レイテンシに対する `relaxed_order` の効果」という測定内容そのものは変わらない）。
 *
 * `SET LOCAL` はトランザクション内でしか効かないため、`db.transaction()` で `BEGIN`
 * してから発行する（ADR 0284 決定1と同じ理由）。
 *
 * **Issue #1301 / ADR 0367**: 下の `SET LOCAL`（`hnsw.iterative_scan` を `relaxed_order` に
 * 変える文）を発行する前に、`capabilityGate` で pgvector がその値を実際に解釈できることを確認する
 * （`PgvectorCapabilityGate` の doc 参照）。0.8 未満では、この `SET LOCAL` は
 * 「初回だけ通り2回目から ERROR」（0.6〜0.7 × PG15+）または「黙って効かない」
 * （0.5.x・PG<15）——検査はこの `SET LOCAL` より**前**に行い、対応していなければ
 * `PgvectorVersionUnsupportedError` を投げて `SET LOCAL` 自体を発行しない
 * （`ann_truncated`/`ann_unreached` を静かに歪めるより、早く・分かりやすく落とす）。
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
 * `search()`/`searchMany()` の両方が使う、`m.*`（memories 側）だけの `WHERE` 条件の
 * 組み立て（ADR 0362、Issue #1181 の直しで `buildFilterConditions` から括り出した）。
 * **`filter` の翻訳ロジックはこの1箇所だけに置く**——`e.tenant_id` 由来の条件（e 側）は
 * ここに含まない（呼び出し側がクエリの形ごとに別に組み立てる。`buildFilterConditions`
 * と `buildLateralMemoryConditions` の doc 参照）。
 *
 * クエリベクトル自体はここでは扱わない——この関数が返す条件は `query`/`qvec` を
 * 一度も参照しない（`WHERE` はどれも `filter` 由来で、距離での絞り込みは
 * `ORDER BY`/`LIMIT` 側の仕事）。
 */
function memoryOnlyConditions(filter: VectorFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.status !== undefined) {
    conditions.push(sql`m.status = ANY(${sql.param(filter.status)}::text[])`);
  }
  // ADR 0165 決めたこと1・4・12: 忘却ゲートの2軸。`decayFloorAnyAxis` が true かつ
  // 両方の境界が渡されているときだけ OR で結ぶ（`VectorFilter.decayFloorAnyAxis` の doc
  // 参照）。それ以外は今日どおり AND のまま個別に効く。
  const decayFloorAtCondition =
    filter.decayFloorAtAfter !== undefined
      ? sql`m.decay_floor_at > ${toPgTimestamp(filter.decayFloorAtAfter)}`
      : undefined;
  // `decay_floor_seq IS NULL` の行は通す（ADR 0165 決めたこと4——NULL は「この軸には
  // 床が無い＝活動時計では沈まない」）。ADR 0353（Issue #338）:
  // `decayFloorSeqUsesSubjectCounters` が true のときだけ、行の subject に対応する
  // `tenant_subject_activity` を相関サブクエリで足す（`activityFloorSeqAliveCondition`
  // の doc コメント参照）。false（既定）のテナントでは今日どおり単一パラメータ比較。
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
  // Issue #608 項目③(b) / ADR 0286: `includeSubjectless: true` のときだけ、等値一致に
  // `subject_id IS NULL`（主題なし）を OR で足す。`subjectId` が無ければこの欄自体を見ない
  // ——「テナント全体」は定義上すでに主題なしを含む上位集合であり、広げる余地が無い。
  if (filter.subjectId !== undefined) {
    conditions.push(
      filter.includeSubjectless === true
        ? sql`(m.subject_id = ${filter.subjectId} OR m.subject_id IS NULL)`
        : sql`m.subject_id = ${filter.subjectId}`,
    );
  }
  // Issue #152/#153（ADR 0312）: AND 等値の絞り込み。`jsonb` の containment（`@>`）——
  // `idx_memories_attributes`（`jsonb_path_ops`）が効く述語。未指定なら no-op。
  if (filter.attributes !== undefined) {
    conditions.push(sql`m.attributes @> ${JSON.stringify(filter.attributes)}::jsonb`);
  }
  // Issue #201 PR-B（ADR 0323）: OR の集合絞り込み。配列の重なり演算子（`&&`）——
  // 渡した名前のうち1つでも `tags` に含まれれば通る。`idx_memories_tags`（GIN）が効く。
  // 未指定なら no-op。
  if (filter.labels !== undefined) {
    conditions.push(sql`m.tags && ${sql.param(filter.labels)}::text[]`);
  }
  // ADR 0059: period の押し下げ。比較対象は COALESCE(occurred_at, recorded_at)
  // （ADR 0039 が定義した「実効時刻」——4箇所あった判定規則の5箇所目)。両端とも包含
  // （`>=`/`<=`）——`VectorFilter.occurredAfter`/`occurredBefore` の doc、および
  // 既存の厳密経路（`memory-store.ts` の `aggregateScope`）と同じ境界の含み方に揃える。
  if (filter.occurredAfter !== undefined) {
    conditions.push(
      sql`COALESCE(m.occurred_at, m.recorded_at) >= ${toPgTimestamp(filter.occurredAfter)}`,
    );
  }
  if (filter.occurredBefore !== undefined) {
    conditions.push(
      sql`COALESCE(m.occurred_at, m.recorded_at) <= ${toPgTimestamp(filter.occurredBefore)}`,
    );
  }
  // Issue #280（Issue #202 第2弾）: `validAt` ゲート。両端 NULL は「いつでも真」
  // （`VectorFilter.validAt` の doc 参照）。`valid_until` は狭義の `>`（非包含）——
  // `decayFloorAtAfter` と同じ境界の向き。
  if (filter.validAt !== undefined) {
    conditions.push(
      sql`(m.valid_from IS NULL OR m.valid_from <= ${toPgTimestamp(filter.validAt)}) AND (m.valid_until IS NULL OR m.valid_until > ${toPgTimestamp(filter.validAt)})`,
    );
  }
  // ADR 0056: 空配列は no-op（`VectorFilter.excludeProvenanceKinds` の doc 参照）。
  // `length > 0` で番わないと `<> ALL('{}')` という無駄な条件が出る——常に真になり実害は
  // 無いが（`<> ALL` は空配列に対して真）、`EXPLAIN` を読みにくくするので出さない。
  if (filter.excludeProvenanceKinds !== undefined && filter.excludeProvenanceKinds.length > 0) {
    conditions.push(
      sql`m.provenance_kind <> ALL(${sql.param(filter.excludeProvenanceKinds)}::text[])`,
    );
  }
  return conditions;
}

/**
 * `search()` が使う `WHERE` 条件の組み立て（Issue #377）。**この関数の戻り値は
 * ADR 0362 の前後で1バイトも変えていない**——`e.tenant_id` の2条件を先頭に置き、
 * 続けて `memoryOnlyConditions` をそのまま連ねるだけで、以前この関数が単体で
 * 持っていたロジックと出力が完全に一致する（`memoryOnlyConditions` へ括り出した
 * のは、`searchMany` が同じ `m.*` の翻訳を別の形（`buildLateralMemoryConditions`）
 * でも使うため——翻訳ロジックの二重化を避ける。二重化するのは「どの条件を
 * 添えるか」ではなく「e 側と m 側をどこで合流させるか」という、クエリの形に
 * 固有の部分だけ）。
 *
 * Issue #1050: テナントは `filter.tenantId` と `ctx.tenantId` の**両方**で絞る（AND）。
 * 隔離の境界は `ctx.tenantId` である（ADR 0007）——`filter.tenantId` だけで絞ると、
 * 2つが食い違ったとき `filter` 側のテナントの行が返る。食い違えば0件になり、例外は
 * 投げない。歯は `__tests__/search-ctx-tenant-boundary.postgres.test.ts`。
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
 * `searchMany` 専用（ADR 0362、Issue #1181）。`search()` の `JOIN memories m ON
 * m.id = e.memory_id AND m.tenant_id = e.tenant_id` は、`searchMany` では
 * `CROSS JOIN LATERAL (SELECT * FROM memories WHERE id = e.memory_id OFFSET 0) m`
 * に置き換わる（`searchMany` の doc コメント、ADR 0362 参照）——`JOIN ... ON` が
 * 無いため、テナント境界（`m.tenant_id = e.tenant_id`）はこの関数が明示的に足す。
 * **これが無いと、統計の有無に関係なく他テナントの行が漏れうる**（Issue #1050 と
 * 同じ境界。`__tests__/search-ctx-tenant-boundary.postgres.test.ts` が縛る）。
 *
 * `m.tenant_id = e.tenant_id` を **LATERAL の中ではなく外側の `WHERE` に置く**のが
 * 唯一の正しい位置——LATERAL の中に足すと、プランナが `memories_pkey`
 * （`id` 単独の一意索引）以外の索引（`idx_memories_recall_gate_seq` 等、
 * `tenant_id` を先頭に持つ索引）も候補にでき、統計が無い場面で実際にそちらを
 * 選んで Issue #1181 の欠陥（`m` を主キーで引かない）に戻ってしまう（ADR 0362
 * 「実測」参照、実測で確認済み）。LATERAL の中身を `id = e.memory_id` **だけ**に
 * 絞ることで、候補になり得る索引を `memories_pkey` 一択にする。
 */
function buildLateralMemoryConditions(filter: VectorFilter) {
  const conditions = [sql`m.tenant_id = e.tenant_id`, ...memoryOnlyConditions(filter)];
  return sql.join(conditions, sql` AND `);
}

/**
 * `search()`/`searchMany()` の両方が使う `e` 側の `WHERE` 条件（統計が無い場面の枝、
 * 候補D で使う。`m` 側は `buildLateralMemoryConditions` が別に返す。ADR 0362・0374）。
 */
function buildEmbeddingConditions(ctx: Ctx, filter: VectorFilter) {
  return sql`e.tenant_id = ${filter.tenantId} AND e.tenant_id = ${ctx.tenantId}`;
}

/**
 * `search()`/`searchMany()` の両方が使う、**統計がある場面**の2枝
 * （`vector_norm > 0`/`= 0`）の `UNION ALL`——`memories` を素の `JOIN memories m ON
 * m.id = e.memory_id AND m.tenant_id = e.tenant_id` で引く、今日と同じ形（ADR 0374、
 * Issue #1415 で `search()`/`searchMany()` に共通のヘルパーへ括り出した。**この関数が
 * 組み立てる SQL は、Issue #1415 の前後で1バイトも変えていない**——`search()` が
 * 元々インラインで持っていたテキストと同一の構造をそのまま返す）。
 *
 * `distanceExpr` は距離演算子の右辺（`search()` では `${queryLiteral}::vector`
 * というリテラル、`searchMany()` では `q.qvec` という `LATERAL` の外側の列——
 * どちらも `sql` の1つの式として同じ場所に嵌まる）。
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
 * `search()`/`searchMany()` の両方が使う、**統計が無い場面**の2枝の `UNION ALL`
 * ——`memories` を主キー（`memories_pkey`）で引く候補D の形（ADR 0362・0374、
 * Issue #1181/#1415）。`LATERAL` の中身は `id = e.memory_id` だけ（`SELECT *`）、
 * `OFFSET 0` は最適化の柵、テナント境界（`m.tenant_id = e.tenant_id`）は柵の外——
 * いずれも ADR 0362「決定」節が実測で固定した3点をそのまま引き継ぐ。
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
 * `memories`・埋め込み表の統計（`pg_class.reltuples`）が両方とも「一度は
 * `ANALYZE`/`VACUUM` された」（`>= 0`）ことを、`PostgresVectorStore` の
 * インスタンス・表ごとに一度だけ確かめ、以後は確かめ直さない（ADR 0374、
 * Issue #1415）。
 *
 * ## なぜインスタンス・表ごとか
 *
 * - **表ごと**: `memories` は全空間で共有されるが、埋め込み表は空間（`EmbeddingSpaceId`）
 *   ごとに別の物理テーブル（`memory_embeddings_<space>`）を持つ。ある空間の埋め込み表が
 *   統計を持っていても、別の空間の埋め込み表はまだ持たないことがある——覚えるのは
 *   埋め込み表の名前ごと（`memories` はテナントに関係なく共有1テーブルなので、
 *   `memories` 自体は表名を持たない特別な1エントリとして覚える）。
 * - **インスタンスごと**（モジュールの大域変数・`static` にしない）: プロセス内に
 *   複数の `PostgresVectorStore` インスタンスが在るとき（例: 複数テナント・複数
 *   接続を使い分ける利用側のコード）、片方が統計を確認済みでも、もう片方は
 *   別に確認する——インスタンスをまたいで共有すると、テストで「別のインスタンスは
 *   まだ確認していない」という前提が壊れ、覚え間違いを検出できなくなる
 *   （歯は `search-stats-presence-scope.postgres.test.ts`）。
 * - **テナントごとには持たない**: 統計は `pg_class` の表単位の情報であり、
 *   テナント単位の情報ではない——`reltuples` の値そのものがテナントを区別しない
 *   （テナントが変わっても、確認済みの状態は同じインスタンス内で共有される）。
 *
 * ## 統計が後で消えたら（`TRUNCATE` 等）
 *
 * **一度 `true` を覚えたら、そのインスタンスの寿命の間ずっと `true` のまま**——
 * 統計が後で消えても（`TRUNCATE`・表の作り直し等）確認し直さない。この場合、
 * **結果は変わらず、遅くなるだけ**（統計が無いのに「ある」前提の SQL を送る
 * ため、Issue #1181/#1415 が直す前と同じプランに戻る可能性があるが、結果の
 * 正しさには影響しない——`search()`/`searchMany()` のどちらの枝も、`filter`
 * が指す集合・順序・同点の決着は同じであることを歯（`__tests__/vector-search-many-diff.postgres.test.ts`・
 * 新設の結果一致の歯）で縛っている）。依頼主はこの代償を受け入れた（ADR 0374）。
 *
 * ## `pg_class.reltuples` の意味
 *
 * 一度も `ANALYZE`/`VACUUM` されていない表は `reltuples` が負（`-1`、
 * PostgreSQL 14 以降の意味。[ADR 0062](../../../docs/decisions/0062-contested-with-id-fk-index.md)
 * 実測参照）になる——「統計が無い」ことそのものを見る、新しい閾値を作らない判定。
 * `to_regclass` は search_path 経由でテーブルを解決する（識別子ではなくテキストの
 * パラメータとして渡す）。
 */
class StatsPresenceGate {
  /** 表名（`memories` は固定の特別なキー）ごとに、確認済み（`reltuples >= 0`）かどうか。 */
  private readonly confirmed = new Set<string>();

  /**
   * `table`（埋め込み表）と `memories` の両方が確認済みなら、往復を発生させずに
   * `true` を返す。どちらかがまだ未確認なら、1回の往復で両方の `reltuples` を
   * 読み、`>= 0` だったものだけを確認済みにする。戻り値は「両方が確認済みか」。
   */
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
 * `VectorStore` の Postgres 実装（docs/architecture.md §5.2、pgvector）。
 *
 * 契約（docs/decisions/0003-memorystore-vs-vectorstore.md）: `MemoryStore` が真実の源であり、
 * `VectorStore` はここに実装があっても再構築可能な派生索引に留まる。
 *
 * `search` の `ORDER BY` には距離演算子の結果をそのまま昇順で書く（式にしない）。
 * これは docs/memory-model.md §10「規約」であり、`testkit`/`packages/postgres` の
 * `EXPLAIN` 検査対象そのものである。
 *
 * **tie-break は3段**（Issue #339 / ADR 0170。ADR 0167 で足した `memory_id` 単独の
 * tie-break は Issue #339 で不十分と判明した——`memory_id` は ingest のたびに
 * `gen_random_uuid()` で新しく振られるランダムな UUID であり、同一 DB 内では
 * 決定的でも、**DB を作り直す（fresh ingest）たびに勝者が変わる**。同一内容が
 * 複数の Memory として重複記録される場面（`examples/chat` の `compare` が使う
 * 合成会話は、少数の filler 文を100回以上使い回すため実際に埋め込みが bit-for-bit
 * 一致する重複を大量に作る）で、この揺れが実際に⭐門の数字を動かした）:
 *
 * 1. 距離（そのまま昇順）。
 * 2. `m.recorded_at`（降順——新しい方を先に。ingest はテナント内で逐次的に行われる
 *    ため、同じ内容を何度作り直して ingest しても、**相対順序は再現する**——
 *    `memory_id` と違って、値そのものはテナントの処理順に紐づく）。
 * 3. `e.memory_id`（最終フォールバック）。**`recorded_at` まで完全一致したとき**
 *    （同一トランザクション内の複数書き込み、あるいは同一ミリ秒内の連続書き込みで
 *    起こりうる——`packages/core/src/runtime.ts` は `clock.now()` を呼び出しごとに
 *    評価するため理論上は稀だが、否定はできない）だけ、ここへ落ちる。**この場合、
 *    まさに ADR 0167 が足した動作（ランダム UUID 順）に戻る**——`recorded_at` が
 *    競合した特定の行どうしの間でだけ、ingest ごとに順序が変わりうる。それ以外の
 *    行（`recorded_at` が競合しない行）の順序には影響しない。
 *
 * **⟹ この3段を足しても「タイが起こらない」ことは保証しない。**保証しているのは
 * 「`recorded_at` が競合しない限り、fresh ingest をまたいで順序が再現する」ことだけ
 * である（ADR 0170「確かめていないこと」参照）。
 *
 * テーブルは事前に `registerEmbeddingSpace`（`./vector-space.ts`）で作られている前提。
 * 未登録の空間に対して呼ぶと Postgres の `relation does not exist` エラーになる
 * （黙って何もしない、より安全な失敗の仕方）。
 */
export class PostgresVectorStore implements VectorStore {
  // Issue #1301 / ADR 0367: インスタンスごとに1つ。`search()`/`searchMany()` の両方の
  // `withRelaxedOrderScan` 呼び出しで共有する（`PgvectorCapabilityGate` の doc 参照）。
  private readonly pgvectorCapabilityGate = new PgvectorCapabilityGate();
  // Issue #1415 / ADR 0374: インスタンスごとに1つ。`search()`/`searchMany()` の両方が
  // 共有する（`StatsPresenceGate` の doc 参照——表ごとに確認済みかを覚え、
  // テナントごとには持たない）。
  private readonly statsPresenceGate = new StatsPresenceGate();

  constructor(private readonly db: Db) {}

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    await this.db.execute(sql`
      INSERT INTO ${sql.identifier(table)} (tenant_id, memory_id, embedding, model, created_at)
      VALUES (${ctx.tenantId}, ${memoryId}, ${toVectorLiteral(vector)}::vector, ${space.model}, now())
      ON CONFLICT (tenant_id, memory_id)
      DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, created_at = now()
    `);
    // Issue #360 / ADR 0194: 統計が実態から遅れているときだけ ANALYZE を撃つ（詳細は
    // ./embedding-statistics.ts のクラス doc）。ここでは呼ぶだけ——判断はそちらに集約する。
    await maybeAnalyzeAfterUpsert(this.db, space);
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    // Issue #857: `query` が空配列だと `toVectorLiteral([])` が `"[]"` を作り、下の
    // `::vector` キャストが「vector must have at least 1 dimension」で未捕捉の
    // `DrizzleQueryError` になっていた（`runtime.recall()` 自体が reject される）。
    // Issue #867: 空ではないが `space.dimensions` と長さが違う `query`（例: 3次元空間に
    // `[1, 2]` や `[1, 2, 3, 4]`）も、pgvector が「different vector dimensions」で
    // 同じ形の未捕捉 `DrizzleQueryError` を投げていた（実測、Issue #867 本文）。
    // 案B（Issue #867 のコメントで決定）: 次元の不一致は「比較不能」として扱う——
    // 新しい throw は足さず、`space.dimensions` 長の全 0 ベクトルに差し替える。
    // ゼロベクトルは ADR 0040 の経路（`<=>` が `NaN` を返す）にそのまま乗り、
    // `recall()` の段2で `score_not_comparable` に数えられる（`omitted` に出る）。
    // 長さが一致する `query` は素通しする——この置き換えは「長さが違う」ときだけ発火する。
    //
    // Fake（`packages/testkit/src/__fixtures__/in-memory-vector-store.ts` の
    // `cosineDistance`、`packages/core/src/__tests__/runtime-fakes.ts` の
    // `FakeVectorStore` にも同じ実装が重複している）は、長さが違う2本のベクトルを
    // 比較しようとしたら `NaN` を返す（足りない側を `0` で zero-pad して計算を続ける
    // 旧実装は Issue #867 で「意味の無い点数を普通のヒットとして返す」と指摘され、
    // 案Bの一部として直した）。ここではその直した後の Fake の挙動に Postgres を揃える。
    // 有限でない成分も同じく比較不能として差し替える（`toComparableQuery` の doc）。
    const effectiveQuery = toComparableQuery(query, space.dimensions);
    const queryLiteral = toVectorLiteral(effectiveQuery);

    // `filter` の翻訳は `searchMany()` と共有する（クラス doc コメント、
    // `buildFilterConditions` 参照）——2箇所で食い違う経路を作らない。
    const whereClause = buildFilterConditions(ctx, opts.filter);

    // ORDER BY には距離演算子の結果をそのまま昇順で置く（式にしない。docs/recall.md §3）。
    // tie-break はクラス doc コメント（このファイル冒頭）のとおり3段
    // （距離 → `m.recorded_at` DESC → `e.memory_id`、Issue #339 / ADR 0170）。
    // **ADR 0167 が足した `e.memory_id` 単独の tie-break では、Issue #339 で
    // 不十分と判明した**——`memory_id` は fresh ingest のたびにランダムに振り直される
    // ため、同一内容の重複行が多数あるとき（`examples/chat` の `compare` の filler
    // 会話がまさにこれを作る）、tie-break の勝者が ingest ごとに変わっていた。
    // `m.recorded_at` はテナント内の処理順に紐づく値であり、fresh ingest をまたいでも
    // **相対順序が再現する**ため、これを第2キーに昇格する。`e.memory_id` は
    // `recorded_at` まで完全一致したときだけ効く最終フォールバックとして残す。
    // ADR 0284: `hnsw.iterative_scan = relaxed_order` を、この SELECT だけを対象に
    // `SET LOCAL` で有効にする。ADR 0063 決定1（有効にしない）を覆す——理由・実測・
    // 覆した経緯は ADR 0284 を見ること。`SET LOCAL` の発行自体は `withRelaxedOrderScan`
    // （このファイル冒頭、`search()`/`searchMany()` で共有）に集約してある——
    // ⚠ `SET LOCAL` の値はプレースホルダで束縛できない（Postgres が `SET` の引数に
    // パラメータ化を許さない）——固定の識別子リテラルとして埋め込む（`withRelaxedOrderScan`
    // 側の実装）。`hnsw.max_scan_tuples` は既定のまま触らない(Issue #671 が記録した天井は、
    // このADRでは引き受けた負債として残す)。
    //
    // Issue #956（ADR 0343）: 下は2枝の `UNION ALL` になっている。pgvector の cosine
    // HNSW 索引は norm が0のベクトル（ゼロベクトル）をそもそも索引へ入れない
    // （pgvector README「Troubleshooting」、実装は `src/hnswutils.c` の
    // `HnswFormIndexValue`/`HnswCheckNorm`）——ORDER BY 押し下げの Index Scan だけに
    // 頼ると、その候補が ADR 0040 の契約（比較不能でも候補として返す）に反して結果から
    // 消える。1枝目（`vector_norm(e.embedding) > 0`）は今日と同じ ORDER BY 押し下げの
    // Index Scan（HNSW）に委ねる——`LIMIT ${opts.limit}` を超えて非ゼロ候補を取る必要は
    // 無い（ゼロベクトルの距離は常に `NaN` で並び順の最後尾に落ちるため、非ゼロ候補の
    // 上位 `limit` 件を先に確定させてよい）。2枝目（`= 0`）は
    // `registerEmbeddingSpace`（`vector-space.ts`）が作る部分索引
    // （`WHERE vector_norm(embedding) = 0`）を使い、`filter` に一致するゼロベクトルの
    // 行を取る——**この枝にも `ORDER BY`/`LIMIT ${opts.limit}` を掛けてある**——
    // 2枝目に内側の LIMIT が無いと、ある空間がゼロベクトルの行を大量に持つ場合、
    // その枝だけがテーブル（の中のゼロベクトル部分）の大きさに比例して増え、
    // 「余分な参照はテーブルの大きさに比例して増えない」という要求から外れる。
    // ゼロベクトルの距離はすべて `NaN` で同点のため、`ORDER BY` は `recorded_at`
    // DESC・`memory_id` の2列（1枝目・外側と同じ tie-break の続き）だけで揃える——
    // 外側の再ソートで同じ2列がそのまま使われるので、内側でこの `LIMIT` を掛けても
    // 「外側で見るべき上位 `limit` 件」を取りこぼさない。2枝を合わせた外側の `SELECT`
    // が両枝を再び1本の順序（距離→`recorded_at` DESC→`memory_id`）へ並べ直し、
    // `LIMIT` をもう一度適用する——ゼロベクトルの行が実在の上位候補を押し出すことは
    // ない（`NaN` は常に最後尾）。往復は増やさない（1本の SQL 文のまま）。
    // Issue #1415 / ADR 0374: `memories`・埋め込み表の両方の統計が確認済みなら
    // （`StatsPresenceGate.bothPresent` の doc 参照）、今日と1バイトも変わらない
    // `buildStatsPresentBranches` の形をそのまま走らせる。未確認のときだけ、確認の
    // ための往復を1回払い、必要なら候補D（`buildStatsMissingBranches`）に切り替える
    // ——ADR 0362 の「One-Time Filter で1本の SQL に両枝を入れる」やり方は、統計が
    // ある場面の実測コストが線を超えたため、この往復ベースの仕組みに替えた
    // （ADR 0374 参照）。
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
    const result = await withRelaxedOrderScan(this.db, this.pgvectorCapabilityGate, (tx) =>
      tx.execute(sql`
        SELECT combined.memory_id AS memory_id, combined.distance AS distance
        FROM (
          ${branches}
        ) AS combined
        ORDER BY combined.distance, combined.recorded_at DESC, combined.memory_id
        LIMIT ${opts.limit}
      `),
    );
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; distance: number };
      return { memoryId: r.memory_id, distance: r.distance };
    });
  }

  /**
   * `search()` を `queries.length` 回呼ぶのと同じ結果を、1回の往復に束ねる
   * （連想枠のアンカーごとの ANN 検索、Issue #377）。`packages/core` の
   * `VectorStore.searchMany?` の doc コメントが定めた契約（`filter`/`limit` は
   * 全クエリで共通、各クエリの結果は `search()` を単独で呼んだ場合と集合・順序が
   * 完全一致する）をそのまま実装する。
   *
   * **束ね方**: `VALUES` で `(query_idx, qvec)` の行を作り、各行に対して
   * `LATERAL` で「その `qvec` を使った ANN 検索」を実行する。`WHERE` 句の
   * `filter` 翻訳（`m.*` 側）は `search()` と同じ `memoryOnlyConditions` を
   * 共有する（`buildLateralMemoryConditions` 経由）——クエリベクトルを
   * 一度も参照しないので、`LATERAL` の中でそのまま使い回せる。
   *
   * **`memories` の引き方は `search()` と完全に同じ仕組みで切り替える（Issue #1415
   * / ADR 0374、ADR 0362 を置き換える）**: `this.statsPresenceGate`（`search()` と
   * 同じインスタンスを共有、クラス doc コメント参照）に「`memories`・この埋め込み表の
   * 両方の統計が確認済みか」を尋ね、
   *
   * - **確認済み**なら、`search()` と1バイトも変わらない `buildStatsPresentBranches`
   *   （素の `JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id`、
   *   `buildFilterConditions` の `WHERE`）をそのまま使う——プランも `Hash Join` 等、
   *   統計に基づいて今まで選ばれてきたものがそのまま選ばれる（歯は
   *   `search-many-primary-key-lookup.postgres.test.ts`）。
   * - **未確認**（表を初めて見る、または過去に見て `reltuples < 0` だった）なら
   *   `buildStatsMissingBranches`（候補D、`CROSS JOIN LATERAL (SELECT * FROM
   *   memories WHERE id = e.memory_id OFFSET 0) m`）を使う——`memories` を主キー
   *   （`memories_pkey`）で引かせる形（Issue #1181 本文・`buildLateralMemoryConditions`
   *   の doc コメント参照）。`OFFSET 0` は Postgres の伝統的な「最適化の柵」——この
   *   副問い合わせを外側へ引き上げず、`e` の行ごとに独立して評価させる。テナント境界
   *   （`m.tenant_id = e.tenant_id`）は柵の**外**（`buildLateralMemoryConditions` が
   *   返す条件の中）に置く——柵の中に入れると `memories_pkey` 以外の索引も候補に
   *   なり得て、Issue #1181 の欠陥に戻る（実測で確認済み）。
   *
   * **往復数**: `statsPresenceGate` が「未確認」の間だけ、`reltuples` を読む
   * ための往復が1回余分に掛かる（`StatsPresenceGate.bothPresent` 自身が投げる
   * `SELECT`）——この余分な往復は `queries.length`（アンカー数）に依存しない
   * （表ごとに1回だけ、`searchMany` 自体の呼び出し回数にも依存しない・確認後は
   * 二度と払わない）。確認済みになったあとは、今日と同じ1往復（この `SELECT`
   * 1本）だけに戻る。
   *
   * **ADR 0362（Issue #1181 当初の決定）からの変更点**: 以前はここで
   * `pg_class.reltuples` を**このクエリ自身の中**でスカラー副問い合わせとして読み、
   * 統計あり・無しの4枝を1本の `UNION ALL` に並べ、Postgres の「One-Time Filter」
   * （実行計画がクエリ全体に対して1回だけ評価する、`LATERAL` の繰り返しに影響
   * されない）に切り替えを任せていた——往復は増えないが、統計がある場面でも
   * `memories`・埋め込み表の `reltuples` を毎回読みに行く分のプランナのコストを
   * 払い続けていた。Issue #1415 で `search()` に同じやり方を適用したところ、
   * 統計がある場面（`recall()` 全体、N=200・アンカー3）で **+5.06ms**
   * という、許容線（約2ms）を大きく超える悪化が固い測り直しで出た（ADR 0374
   * 「実測」参照）——この仕組みを `search()`/`searchMany()` の両方から外し、
   * インスタンスへの記憶（このクラス doc コメント、`StatsPresenceGate` の doc
   * コメント参照）に置き換えた。
   *
   * **key は SQL に送らない**（[Issue #1285](https://github.com/takecchi/mnemora/issues/1285)）: `VALUES` には
   * 送るクエリの添字（`0..n-1`）を送り、戻った行を、そのクエリの key へ引き直す。以前は key を `text` の
   * パラメータとして送っていたので、NUL（U+0000）を含む key を Postgres が拒み、`search()` が投げない入力で
   * `searchMany` だけが投げていた。
   *
   * **同じ key が2回以上あるときは、最後のクエリだけを送る**（[Issue #1284](https://github.com/takecchi/mnemora/issues/1284)、
   * `VectorStore.searchMany?` の契約）。`Map` の並びは、先に全部の key を `set` した順（最初に現れた位置）のまま。
   * 以前は全部を送り、同じ配列に結果を続けて積んでいた（`limit` を超えうる）。
   *
   * **`hnsw.iterative_scan` は `search()` と同じ `withRelaxedOrderScan`（このファイル
   * 冒頭）を経由して1回だけ効かせる**——`LATERAL` は同じトランザクション・同じ SELECT
   * 文の中で複数回実行されるが、`SET LOCAL` はトランザクション単位で効くセッション
   * 変数であり、`LATERAL` の繰り返し1回ごとに再設定する必要はない（ADR 0284、
   * `search()` と同じ理由）。この `SET LOCAL` 文をこのメソッドが複製しないのは、
   * `hnsw-ef-search-window-ceiling.test.ts` 検査2（ADR 0284）が「`vector-store.ts`
   * の中で1箇所だけ」を固定しているため——`withRelaxedOrderScan` の doc コメント参照。
   *
   * `EXPLAIN` で確認済み（PR 本文に抜粋）: `LATERAL` の内側でも
   * `Index Scan using ...hnsw...` が選ばれ、アンカーの数だけ `loops=N` で
   * 繰り返される——`Seq Scan` に落ちない。
   *
   * Issue #956（ADR 0343）: `buildStatsPresentBranches`/`buildStatsMissingBranches`
   * の中身は、それぞれ `vector_norm(e.embedding) > 0` の ORDER BY 押し下げ枝 + `= 0`
   * の部分索引枝を持つ（`UNION ALL` 2枝、`search()` と共有するヘルパー——上の
   * クラス doc 参照）。
   */
  async searchMany(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    queries: { key: string; vector: number[] }[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<Map<string, VectorHit[]>> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    const resultMap = new Map<string, VectorHit[]>();
    // 契約（`VectorStore.searchMany?` の doc コメント）: `queries` の `key` の集合は
    // 返り値の `Map` にそのまま現れる——結果が0件の key も欠落させない。
    for (const q of queries) {
      resultMap.set(q.key, []);
    }
    if (queries.length === 0) {
      // 契約: 空配列なら往復を発生させずに空の Map を返す。
      return resultMap;
    }
    // 契約: 同じ key が2回以上あるときは、最後のクエリの結果だけを返す（Issue #1284）。
    // `Map` の並びは上の `set` のまま（最初に現れた位置）。それより前のクエリは SQL に送らない。
    const lastIndexByKey = new Map<string, number>();
    queries.forEach((q, index) => lastIndexByKey.set(q.key, index));
    const effectiveQueries = queries.filter((q, index) => lastIndexByKey.get(q.key) === index);

    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);

    // Issue #1415 / ADR 0374: `search()` と同じ `StatsPresenceGate` を共有する
    // ——両方の統計が確認済みなら、`search()` と1バイトも変わらない
    // `buildStatsPresentBranches`（素の `JOIN memories m ON ...`）を、未確認/無しなら
    // 候補D（`buildStatsMissingBranches`）を使う。ADR 0362 の「1本の SQL に両枝を
    // 入れて One-Time Filter で切り替える」やり方は、統計がある場面の実測コストが
    // 線を超えたため、この往復ベースの仕組みに替えた（ADR 0374 参照）。
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

    // `search()` と同じ次元不一致の扱い（Issue #867 案B）——クエリごとに独立して適用する。
    // key ではなく添字を送る（上の doc コメント、Issue #1285）。
    const valuesRows = effectiveQueries.map((q, index) => {
      const effectiveQuery = toComparableQuery(q.vector, space.dimensions);
      return sql`(${index}::int, ${toVectorLiteral(effectiveQuery)}::vector)`;
    });

    const result = await withRelaxedOrderScan(this.db, this.pgvectorCapabilityGate, (tx) =>
      tx.execute(sql`
        SELECT q.query_idx AS query_idx, hit.memory_id AS memory_id, hit.distance AS distance
        FROM (VALUES ${sql.join(valuesRows, sql`, `)}) AS q(query_idx, qvec)
        CROSS JOIN LATERAL (
          SELECT combined.memory_id AS memory_id, combined.distance AS distance
          FROM (
            ${branches}
          ) AS combined
          ORDER BY combined.distance, combined.recorded_at DESC, combined.memory_id
          LIMIT ${opts.limit}
        ) AS hit
      `),
    );
    for (const row of result.rows) {
      const r = row as unknown as { query_idx: number; memory_id: string; distance: number };
      resultMap
        .get(effectiveQueries[r.query_idx]!.key)
        ?.push({ memoryId: r.memory_id, distance: r.distance });
    }
    return resultMap;
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    // memory_id 列は uuid 型。この口の契約は「無い == 何もしない」（void、族A）なので、
    // 形式が壊れた memoryId もクエリを投げる前に同じ no-op へ寄せる——DELETE は
    // 0行に終わるだけで実害は無いが、素通しすると invalid input syntax for type uuid が
    // 飛んでしまい「無い」と「壊れた入力」の区別が呼び出し側に漏れる
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(memoryId)) {
      return;
    }
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    await this.db.execute(sql`
      DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
    `);
  }

  /**
   * `ctx.tenantId` に属する `memoryIds` の行を、この DB 接続が見ている
   * `current_schema()` の中の**全 space**（`memory_embeddings_<space>` テーブル全部）
   * から消す（Issue #1425、[ADR 0382](../../../docs/decisions/0382-vector-store-delete-across-spaces.md)）。
   *
   * `packages/core` の `VectorStore.deleteAcrossSpaces` の doc コメントが定める契約
   * （存在しない/形式不正な id は no-op、他テナントの行は消さない、空配列は no-op）を
   * そのまま実装する。
   *
   * ## テーブルの列挙（3条件、ADR 0382 決定2）
   *
   * {@link listEmbeddingSpaceTables}（`embedding-space-catalog.ts`）へ切り出した
   * （Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md)——
   * `eraseTenant?`（下）が同じ列挙を必要としたため共通化した）。3条件の詳細は
   * 同関数の doc コメントを参照:
   *
   * 1. **`current_schema()` の中のテーブルだけ**——スキーマを跨がない。dedicated-schema
   *    （`registerEmbeddingSpace` の `options.schema`）で複数の mnemora デプロイが
   *    同じ DB に同居していても、この接続が見ているスキーマの外のテーブルには触れない。
   *    **列挙で見つけたスキーマ名を、`DELETE` 文自体にも明示的に付ける**（下記参照）
   *    ——`search_path` の解決には頼らない。
   * 2. **テーブル名が `memory_embeddings_` で始まる**（`embeddingSpaceTableName` の
   *    導出と同じ接頭辞）。
   * 3. **`memory_id` 列が、同じスキーマの `memories(id)` を外部キーで参照している**
   *    （`pg_constraint`/`pg_attribute` で確かめる）——利用者が同じ命名慣習
   *    （`memory_embeddings_` で始まる名前）で作った無関係なテーブルを巻き込まない。
   *
   * `registerEmbeddingSpace`（`vector-space.ts`）が作るテーブルは、この3条件を
   * すべて満たす（`tenant_id`/`memory_id` の複合主キー、`memory_id uuid NOT NULL
   * REFERENCES memories(id)`）。
   *
   * **`DELETE` はスキーマ修飾する（`search_path` に頼らない）。** 列挙のクエリが
   * `n.nspname`（テーブルの属するスキーマ名）も一緒に返し、`DELETE` の対象を
   * `${sql.identifier(schema)}.${sql.identifier(table)}` の形で完全修飾する
   * ——`upsert`/`search`/`delete` 等の他のメソッド（未修飾の裸のテーブル名を使い、
   * 接続の `search_path` に解決を任せる、`schema-namespace.ts` のクラス doc が言う
   * 既定の DML の形）とはこの1点だけ異なる。⚠ **理由**: `current_schema()` は
   * 接続の `search_path` の**先頭**を指すだけであり、`search_path` が複数のスキーマを
   * 含む構成（利用者が `ALTER ROLE ... SET search_path = s1, s2` 等で設定した場合）
   * では、未修飾の `DELETE FROM <table>` が実際に解決するスキーマと
   * `current_schema()` が一致しない可能性がある——列挙を `current_schema()` で絞っても、
   * 未修飾の `DELETE` がその絞り込みどおりのテーブルに当たる保証にはならない
   * （2つのスキーマに同名のテーブルが存在する場合、列挙した `n.nspname` と、
   * `DELETE` が実際に解決するスキーマがずれうる）。スキーマ名を明示することで、
   * 「列挙で選んだテーブル」と「実際に `DELETE` するテーブル」を1対1に固定する。
   *
   * **台帳を持たない**（ADR 0002 決定—— space ごとに別テーブルという設計そのものが
   * 「このテナントが使った space の一覧」を別に持たなくても、カタログを読めば
   * 列挙できる形にしている）。
   *
   * 列挙と削除は**1つのトランザクション**の中で行う——列挙はカタログ（`pg_class`/
   * `pg_constraint`/`pg_attribute`）を読むだけで対象テーブルの行ロックは取らず、
   * 各 `DELETE` は該当テーブルの対象行だけを行ロックする。テーブル本数が多くても、
   * 特定のテーブルを長く掴み続けることはない（推測——実測はしていない。ADR 0382
   * 「確かめていないこと」参照）。
   */
  async deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void> {
    assertWellFormedCtx(ctx);
    // `delete` と同じ規律（`isUuidLike` の doc コメント参照）——形式不正な id は
    // 「存在しない」の一種として扱い、クエリを投げる前に落とす。空配列（または全件
    // 形式不正）なら、列挙のクエリすら発行せずに返る。
    const validIds = memoryIds.filter(isUuidLike);
    if (validIds.length === 0) {
      return;
    }
    await this.db.transaction(async (tx) => {
      // Issue #1207 / ADR 0383: 列挙は `listEmbeddingSpaceTables`（`embedding-space-catalog.ts`）
      // に切り出した——`eraseTenant`（下）と同じ条件を共有する。
      const tables = await listEmbeddingSpaceTables(tx);
      for (const { table, schema } of tables) {
        // `pg_class.relname`/`pg_namespace.nspname` は既に有効な PostgreSQL 識別子だが、
        // `assertSafeIdentifier`/`assertSafeSchemaName` を通す——他のメソッドと同じ
        // 「SQL 注入対策の最後の砦」の規律をここでも揃える。
        assertSafeIdentifier(table);
        assertSafeSchemaName(schema);
        await tx.execute(sql`
          DELETE FROM ${sql.identifier(schema)}.${sql.identifier(table)}
          WHERE tenant_id = ${ctx.tenantId} AND memory_id = ANY(${sql.param(validIds)}::uuid[])
        `);
      }
    });
  }

  /**
   * Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md):
   * `VectorStore.eraseTenant?` の実装。`deleteAcrossSpaces`（上）と同じ
   * `listEmbeddingSpaceTables` で全 space のテーブルを列挙し、`memoryIds` の集合では
   * なく `ctx.tenantId` の行を丸ごと対象にする点だけが違う。
   *
   * `opts.limit` は**全 space の合計**に対する budget として消費する
   * （1つの space だけで使い切ってもよい——`MemoryStore.eraseTenant` の interface doc
   * が定める「保守的な近似」の `reachedLimit` をここでも採用する）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun === true;
    return this.db.transaction(async (tx) => {
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
    });
  }

  async getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: MemoryId[],
  ): Promise<VectorEntry[]> {
    assertWellFormedCtx(ctx);
    // `memory_id` 列は uuid 型。形式不正な id は「存在しない」の一種として扱う
    // （`delete` と同じ判断。`isUuidLike` の doc コメント参照）——クエリを投げる前に
    // 落とし、DB 由来の invalid input syntax を漏らさない。
    const validIds = memoryIds.filter(isUuidLike);
    if (validIds.length === 0) {
      return [];
    }
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    // tenant 境界を必ず掛ける（`VectorEntry` の doc・`search` の `filter.tenantId` と
    // 同じ境界）——他テナントの memoryId が偶然 validIds に混ざっていても返さない。
    const result = await this.db.execute(sql`
      SELECT memory_id AS memory_id, embedding::text AS embedding
      FROM ${sql.identifier(table)}
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ANY(${sql.param(validIds)}::uuid[])
    `);
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; embedding: string };
      return { memoryId: r.memory_id, vector: parseVectorLiteral(r.embedding) };
    });
  }
}
