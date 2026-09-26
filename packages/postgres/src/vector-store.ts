import { sql } from "drizzle-orm";
import type {
  Ctx,
  EmbeddingSpaceId,
  MemoryId,
  VectorEntry,
  VectorFilter,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";
import { isUuidLike } from "./mapping.js";
import { maybeAnalyzeAfterUpsert } from "./embedding-statistics.js";

/** `number[]` を pgvector のテキスト表現（`[1,2,3]`）に変換する。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** `toVectorLiteral` の逆——pgvector のテキスト表現（`[1,2,3]`）を `number[]` に戻す。 */
function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
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
 */
async function withRelaxedOrderScan<T>(
  db: Db,
  run: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return run(tx);
  });
}
/**
 * `search()`/`searchMany()` の両方が使う `WHERE` 条件の組み立て。**同じヘルパーを
 * 両方から呼ぶことで、`filter` の翻訳が2箇所で食い違う経路を作らない**（Issue #377、
 * `VectorStore.searchMany?` の doc コメントが要求する「`search()` を単独で呼んだ場合と
 * 集合・順序ともに完全に一致する」契約の土台）。クエリベクトル自体はここでは扱わない
 * ——この関数が返す条件は `query`/`qvec` を一度も参照しない（`WHERE` はどれも
 * `filter` 由来で、距離での絞り込みは `ORDER BY`/`LIMIT` 側の仕事）。
 */
function buildFilterConditions(filter: VectorFilter) {
  const conditions = [sql`e.tenant_id = ${filter.tenantId}`];
  if (filter.status !== undefined) {
    conditions.push(sql`m.status = ANY(${sql.param(filter.status)}::text[])`);
  }
  // ADR 0165 決めたこと1・4・12: 忘却ゲートの2軸。`decayFloorAnyAxis` が true かつ
  // 両方の境界が渡されているときだけ OR で結ぶ（`VectorFilter.decayFloorAnyAxis` の doc
  // 参照）。それ以外は今日どおり AND のまま個別に効く。
  const decayFloorAtCondition =
    filter.decayFloorAtAfter !== undefined
      ? sql`m.decay_floor_at > ${filter.decayFloorAtAfter}`
      : undefined;
  // `decay_floor_seq IS NULL` の行は通す（ADR 0165 決めたこと4——NULL は「この軸には
  // 床が無い＝活動時計では沈まない」）。
  const decayFloorSeqCondition =
    filter.decayFloorSeqAfter !== undefined
      ? sql`(m.decay_floor_seq IS NULL OR m.decay_floor_seq > ${filter.decayFloorSeqAfter})`
      : undefined;
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
    conditions.push(sql`COALESCE(m.occurred_at, m.recorded_at) >= ${filter.occurredAfter}`);
  }
  if (filter.occurredBefore !== undefined) {
    conditions.push(sql`COALESCE(m.occurred_at, m.recorded_at) <= ${filter.occurredBefore}`);
  }
  // Issue #280（Issue #202 第2弾）: `validAt` ゲート。両端 NULL は「いつでも真」
  // （`VectorFilter.validAt` の doc 参照）。`valid_until` は狭義の `>`（非包含）——
  // `decayFloorAtAfter` と同じ境界の向き。
  if (filter.validAt !== undefined) {
    conditions.push(
      sql`(m.valid_from IS NULL OR m.valid_from <= ${filter.validAt}) AND (m.valid_until IS NULL OR m.valid_until > ${filter.validAt})`,
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
  return sql.join(conditions, sql` AND `);
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
  constructor(private readonly db: Db) {}

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
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
    const effectiveQuery =
      query.length === space.dimensions ? query : new Array(space.dimensions).fill(0);
    const queryLiteral = toVectorLiteral(effectiveQuery);

    // `filter` の翻訳は `searchMany()` と共有する（クラス doc コメント、
    // `buildFilterConditions` 参照）——2箇所で食い違う経路を作らない。
    const whereClause = buildFilterConditions(opts.filter);

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
    const result = await withRelaxedOrderScan(this.db, (tx) =>
      tx.execute(sql`
        SELECT combined.memory_id AS memory_id, combined.distance AS distance
        FROM (
          (
            SELECT e.memory_id AS memory_id, e.embedding <=> ${queryLiteral}::vector AS distance,
                   m.recorded_at AS recorded_at
            FROM ${sql.identifier(table)} e
            JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
            WHERE ${whereClause} AND vector_norm(e.embedding) > 0
            ORDER BY e.embedding <=> ${queryLiteral}::vector, m.recorded_at DESC, e.memory_id
            LIMIT ${opts.limit}
          )
          UNION ALL
          (
            SELECT e.memory_id AS memory_id, e.embedding <=> ${queryLiteral}::vector AS distance,
                   m.recorded_at AS recorded_at
            FROM ${sql.identifier(table)} e
            JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
            WHERE ${whereClause} AND vector_norm(e.embedding) = 0
            ORDER BY m.recorded_at DESC, e.memory_id
            LIMIT ${opts.limit}
          )
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
   * **束ね方**: `VALUES` で `(query_key, qvec)` の行を作り、各行に対して
   * `LATERAL` で「その `qvec` を使った ANN 検索」を実行する。`LATERAL` の中身は
   * `search()` の `SELECT`（`WHERE`/`ORDER BY`/`LIMIT`）と1文字も変えていない
   * ——変わるのは、クエリベクトルの出どころがプレースホルダ1個（`queryLiteral`）
   * から `q.qvec`（`VALUES` の列）になっただけである。`WHERE` 句は
   * `buildFilterConditions`（`search()` と共有、関数の doc 参照）——クエリベクトルを
   * 一度も参照しないので、`LATERAL` の中でそのまま使い回せる。
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
   * Issue #956（ADR 0343）: `LATERAL` の中身も `search()` と同じ2枝の `UNION ALL`
   * （`vector_norm(e.embedding) > 0` の ORDER BY 押し下げ枝 + `= 0` の部分索引枝）に
   * なっている——`search()` の doc コメント参照。**往復数は変えていない**——
   * `UNION ALL`/再ソートは `LATERAL` サブクエリの中に収めてあり、`queries.length`
   * が増えても発行する SQL 文は今日と同じ1本のまま
   * （`vector-store-search-many.postgres.test.ts` の「往復数が anchorCount に依存しない」
   * 歯を壊さないことを実測で確認済み）。
   */
  async searchMany(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    queries: { key: string; vector: number[] }[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<Map<string, VectorHit[]>> {
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

    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    const whereClause = buildFilterConditions(opts.filter);

    // `search()` と同じ次元不一致の扱い（Issue #867 案B）——クエリごとに独立して適用する。
    const valuesRows = queries.map((q) => {
      const effectiveQuery =
        q.vector.length === space.dimensions ? q.vector : new Array(space.dimensions).fill(0);
      return sql`(${q.key}::text, ${toVectorLiteral(effectiveQuery)}::vector)`;
    });

    const result = await withRelaxedOrderScan(this.db, (tx) =>
      tx.execute(sql`
        SELECT q.query_key AS query_key, hit.memory_id AS memory_id, hit.distance AS distance
        FROM (VALUES ${sql.join(valuesRows, sql`, `)}) AS q(query_key, qvec)
        CROSS JOIN LATERAL (
          SELECT combined.memory_id AS memory_id, combined.distance AS distance
          FROM (
            (
              SELECT e.memory_id AS memory_id, e.embedding <=> q.qvec AS distance,
                     m.recorded_at AS recorded_at
              FROM ${sql.identifier(table)} e
              JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
              WHERE ${whereClause} AND vector_norm(e.embedding) > 0
              ORDER BY e.embedding <=> q.qvec, m.recorded_at DESC, e.memory_id
              LIMIT ${opts.limit}
            )
            UNION ALL
            (
              SELECT e.memory_id AS memory_id, e.embedding <=> q.qvec AS distance,
                     m.recorded_at AS recorded_at
              FROM ${sql.identifier(table)} e
              JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
              WHERE ${whereClause} AND vector_norm(e.embedding) = 0
              ORDER BY m.recorded_at DESC, e.memory_id
              LIMIT ${opts.limit}
            )
          ) AS combined
          ORDER BY combined.distance, combined.recorded_at DESC, combined.memory_id
          LIMIT ${opts.limit}
        ) AS hit
      `),
    );
    for (const row of result.rows) {
      const r = row as unknown as { query_key: string; memory_id: string; distance: number };
      resultMap.get(r.query_key)?.push({ memoryId: r.memory_id, distance: r.distance });
    }
    return resultMap;
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
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

  async getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: MemoryId[],
  ): Promise<VectorEntry[]> {
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
