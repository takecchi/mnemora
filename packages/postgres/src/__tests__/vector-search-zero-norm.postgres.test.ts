import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  type CapturedQuery,
  captureClientQuery,
  closeTestClient,
  explainCaptured,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
  seededRandom,
} from "./test-db.js";

const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

/**
 * Issue #956（ADR 0343）: pgvector の cosine HNSW 索引は norm が0のベクトル
 * （ゼロベクトル）をそもそも索引へ入れない（pgvector README「Troubleshooting」、
 * 実装は `src/hnswutils.c` の `HnswFormIndexValue`/`HnswCheckNorm`）。この歯は
 * **HNSW（または、他に選べる索引が無い状態での Index Scan）が実際に選ばれている
 * 状態でも**、ゼロベクトルの候補が `search()`/`searchMany()` の結果から落ちないことを
 * 検査する。
 *
 * ⚠ **歯1（EXPLAIN）と歯2〜5（返り値）で、HNSW を選ばせる手段を変えてある。**
 * 自然な行数増加（`vector-search-hnsw.test.ts` と同じ形）だけでは、この2つを
 * **同時に**満たせないと実測で分かった:
 *
 * - ゼロベクトルの候補は距離が常に `NaN`（最大値扱い、ADR 0040）——`limit` が
 *   非ゼロ候補の総数より小さいと、直しても直さなくても「limit 内に入らない」
 *   （本 Issue の対象外、LIMIT の正しい切り捨て）でゼロ候補が消える。
 * - ⟹ ゼロ候補を確実に含めるには `limit` を非ゼロ候補の総数より大きくする必要がある。
 * - しかし `limit` が非ゼロ候補の総数に近づく（≒ 全件を取りたい）と、プランナは
 *   Seq Scan + 明示 Sort を選ぶほうが安いと判断する（【実測】3,000行・`limit=3010`
 *   で確認——Seq Scan なら（直す前でも）ゼロ候補を正しく返す。これは「直った」
 *   のではなく、そもそも HNSW を経由していないだけである）。
 * - 対象テナントの非ゼロ候補を少数に抑え、他テナントの行で表だけを大きくする
 *   （ADR 0284/Issue #671 と同じ形）と、その少数テナント向けの検索は
 *   `tenant_id` 一致で絞り込める主キー索引（`(tenant_id, memory_id)`）の
 *   ほうが安いとプランナが判断し、やはり HNSW を経由しない（【実測】）。
 *
 * ⟹ **「HNSW（cosine 索引）を確実に経由させつつ、ゼロ候補が limit 内に収まる」
 * という組み合わせを、行数・統計の調整だけで自然に作ることはできなかった。**
 * 歯2〜5は `SET LOCAL enable_seqscan = off` / `enable_bitmapscan = off`
 * （マネージャーの指示が明示的に許した代替手段）で強制する——`search()`/
 * `searchMany()` が実際に組み立てる SQL 文字列・パラメータを `captureClientQuery`
 * で捕まえ、`enable_seqscan`/`enable_bitmapscan` を切った専用の接続でそのまま
 * 再生する（`runForcedIndexOnly`、下記）。**残る唯一の道（`ORDER BY` を満たす
 * 索引としての HNSW、`= 0` を満たす索引としての部分索引）だけが選べる状態で、
 * 実際に何が返るかを見る。**
 *
 * 歯1（EXPLAIN）だけは、`vector-search-hnsw.test.ts` と同じ「行数を増やし
 * `ANALYZE` してプランナに自然に選ばせる」形を保つ——**強制する前の、素の状態でも
 * 現実の規模なら HNSW が選ばれる**という前提そのものが崩れていないことの
 * 独立した確認になる。
 *
 * 🔴 **歯2〜5は、修正前（`vector_norm` の部分索引・`UNION ALL` を足す前）の
 * `vector-store.ts` では赤くなることを、`cp` で退避した旧実装に差し替えて実測済み**
 * （`docs/autonomy.md`/`AGENTS.md`「⛔ 変異を戻すのに git checkout を使わない」の作法）。
 * 赤の実際の出力は PR 本文 / ADR 0343「一次実測」に記録している。
 */

const TENANT = "zero-norm-tenant";
const HNSW_ROW_COUNT = 3000;

async function analyzeTable(pool: Pool): Promise<void> {
  // `vector-search-hnsw.test.ts` と同じ理由: ANALYZE 無しでは主キー索引が選ばれ、
  // HNSW 索引が選ばれない（実測、同ファイルのコメント参照）。
  await pool.query(`ANALYZE ${TABLE}`);
  await pool.query("ANALYZE memories");
}

/** 歯1（EXPLAIN で HNSW が選ばれることの確認）専用の seed。`vector-search-hnsw.test.ts` と同じ形。 */
async function seedForHnswPlanCheck(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  pool: Pool,
): Promise<void> {
  const rand = seededRandom(20260927);
  for (let i = 0; i < HNSW_ROW_COUNT; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [rand(), rand(), rand()]);
  }
  const zeroMemory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, zeroMemory.id, [0, 0, 0]);
  await analyzeTable(pool);
}

/** 歯2〜5（返り値の正しさ）専用の、小規模な seed。`vector-store-conformance.ts` と同じ規模。 */
async function seedSmall(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
): Promise<{ zeroMemoryId: string; okMemoryIds: string[] }> {
  const okMemoryIds: string[] = [];
  for (const vector of [
    [1, 0, 0],
    [0, 1, 0],
  ]) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
    okMemoryIds.push(memory.id);
  }
  const zeroMemory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, zeroMemory.id, [0, 0, 0]);
  return { zeroMemoryId: zeroMemory.id, okMemoryIds };
}

/**
 * `captured`（`captureClientQuery` が捕まえた、`search()`/`searchMany()` が実際に
 * 発行する SQL・パラメータ）を、`enable_seqscan`/`enable_bitmapscan` を切った専用の
 * 接続で実行する——`ORDER BY` を満たす索引としては HNSW（`vector_cosine_ops`）、
 * `vector_norm(...) = 0` を満たす索引としては本 Issue が足した部分索引しか
 * 残らない状態で、実際に返る行を見る。`explainCaptured`（`test-db.ts`）と同じ形
 * （`precedingSetLocalStatements` を同じ接続・同じトランザクションで先に再生してから
 * 本体を実行する）だが、`EXPLAIN` ではなく実データを取る点が違う。
 */
async function runForcedIndexOnly(
  pool: Pool,
  captured: CapturedQuery,
): Promise<{ memory_id: string; distance: number }[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    await client.query("SET LOCAL enable_bitmapscan = off");
    for (const statement of captured.precedingSetLocalStatements) {
      await client.query(statement);
    }
    const result = await client.query(captured.text, captured.params);
    return result.rows as { memory_id: string; distance: number }[];
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("PostgresVectorStore.search/searchMany と HNSW（または Index Scan 限定）でのゼロベクトル候補（Issue #956）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("歯1: 現実的な規模（3,000行 + ANALYZE）では、強制せずとも非ゼロ候補側は HNSW Index Scan が選ばれる（退行検査）", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    await seedForHnswPlanCheck(memoryStore, vectorStore, ctx, pool);

    const captured = await captureClientQuery(
      (text) => text.includes(TABLE) && /union all/i.test(text),
      () =>
        vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [0.5, 0.5, 0.5], {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    const plan = await explainCaptured(pool, captured);
    // 非ゼロ枝（`vector_norm(e.embedding) > 0`）は今日と同じ HNSW Index Scan。
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    // ゼロ枝（`= 0`）は部分索引を使う——テーブル全体を Seq Scan しない
    // （部分索引の名前は `idx_memory_embeddings_zero_norm_...` で始まる）。
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_zero_norm/);
    expect(plan).not.toMatch(/Seq Scan on memory_embeddings/);
  }, 60_000);

  it("歯2: enable_seqscan/enable_bitmapscan を切って Index Scan 限定にしても、search() はゼロベクトルの候補を結果に含める", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { zeroMemoryId, okMemoryIds } = await seedSmall(memoryStore, vectorStore, ctx);

    const captured = await captureClientQuery(
      (text) => text.includes(TABLE) && /union all/i.test(text),
      () =>
        vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    const rows = await runForcedIndexOnly(pool, captured);
    const zeroRow = rows.find((r) => r.memory_id === zeroMemoryId);
    expect(
      zeroRow,
      "🔴 enable_seqscan/enable_bitmapscan を切った状態で、ゼロベクトルの候補が " +
        "search() の結果から消えている（Issue #956・pgvector の HNSW は norm=0 の " +
        "ベクトルを索引に入れないため）",
    ).toBeDefined();
    expect(Number.isNaN(zeroRow!.distance)).toBe(true);
    // 非ゼロ候補も両方生きている（部分索引を足したことで非ゼロ側が壊れていないこと）。
    expect(rows.map((r) => r.memory_id)).toEqual(expect.arrayContaining(okMemoryIds));
  }, 60_000);

  it("歯3: enable_seqscan/enable_bitmapscan を切って Index Scan 限定にしても、searchMany() は各クエリの結果にゼロベクトルの候補を含める", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { zeroMemoryId } = await seedSmall(memoryStore, vectorStore, ctx);

    const captured = await captureClientQuery(
      (text) => text.includes(TABLE) && /union all/i.test(text) && /lateral/i.test(text),
      () =>
        vectorStore.searchMany!(
          ctx,
          TEST_EMBEDDING_SPACE,
          [
            { key: "anchor-1", vector: [1, 0, 0] },
            { key: "anchor-2", vector: [0, 1, 0] },
          ],
          { limit: 10, filter: { tenantId: TENANT } },
        ),
    );
    const rows = (await runForcedIndexOnly(pool, captured)) as unknown as {
      query_key: string;
      memory_id: string;
      distance: number;
    }[];

    for (const key of ["anchor-1", "anchor-2"]) {
      const zeroRow = rows.find((r) => r.query_key === key && r.memory_id === zeroMemoryId);
      expect(
        zeroRow,
        `🔴 searchMany() の ${key} で、Index Scan 限定の状態でゼロベクトルの候補が消えている（Issue #956）`,
      ).toBeDefined();
      expect(Number.isNaN(zeroRow!.distance)).toBe(true);
    }
  }, 60_000);

  it("歯4: HNSW が選ばれている状態でも search() はゼロベクトルの候補を実際に返す（強制なし、素の呼び出し）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { zeroMemoryId } = await seedSmall(memoryStore, vectorStore, ctx);

    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const zeroHit = hits.find((hit) => hit.memoryId === zeroMemoryId);
    expect(zeroHit, "🔴 素の search() 呼び出しでもゼロベクトルの候補が消えている").toBeDefined();
    expect(zeroHit!.distance >= 0).toBe(false);
    expect(zeroHit!.distance <= 0).toBe(false);
  }, 60_000);

  it("歯5: search() が単独で返す集合と、searchMany() がそのクエリに対して返す集合は一致する（Issue #377 の契約、ゼロベクトル込み）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    await seedSmall(memoryStore, vectorStore, ctx);

    const query = [1, 0, 0];
    const singleHits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, query, {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const manyResult = await vectorStore.searchMany!(
      ctx,
      TEST_EMBEDDING_SPACE,
      [{ key: "only", vector: query }],
      { limit: 10, filter: { tenantId: TENANT } },
    );
    const manyHits = manyResult.get("only") ?? [];

    expect(manyHits.map((h) => h.memoryId)).toEqual(singleHits.map((h) => h.memoryId));
  }, 60_000);
});
