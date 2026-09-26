import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, VectorFilter } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
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
 * `VectorStore.searchMany?`（任意メソッド、Issue #377）の `PostgresVectorStore` 実装が、
 * 契約（`packages/core/src/interfaces/vector-store.ts` の doc コメント）——
 * 「各 `queries[i]` に対する結果は `search(ctx, space, queries[i].vector, opts)` を
 * 単独で呼んだ場合と、集合・順序ともに完全に一致する」——を満たすことを検査する。
 *
 * `search()`/`searchMany()` は同じ `buildFilterConditions`（`vector-store.ts`）を
 * 使い、`ORDER BY` の3段 tie-break（距離 → `recorded_at` DESC → `memory_id`、
 * Issue #339 / ADR 0170）も同じ式をそのまま `LATERAL` の中に書いている——
 * この歯は「実装がその作り方どおりに動いている」ことを実地で確かめる。
 */
async function countClientQueries(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    count += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return count;
}

describe("PostgresVectorStore.searchMany — search() との一致（Issue #377）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("歯1: 距離の同点（recorded_at DESC・memory_id フォールバック）を含め、複数クエリの結果が search() と集合・順序ともに完全一致する", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: `svm-tie-${Date.now()}` };

    const QUERY_A: number[] = [1, 0, 0];
    const QUERY_B: number[] = [0, 1, 0];

    // QUERY_A と距離0で完全に同点になる2件——recorded_at が新しい方が先に来るはず
    // （vector-search-tiebreak.test.ts と同じ手法）。
    const aOlder = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, aOlder.id, QUERY_A);
    const aNewer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, aNewer.id, QUERY_A);

    // QUERY_A と距離0・recorded_at も完全一致——memory_id へフォールバックする組。
    const sameRecordedAt = new Date("2026-01-03T00:00:00.000Z");
    const aFallback1 = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, recordedAt: sameRecordedAt }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, aFallback1.id, QUERY_A);
    const aFallback2 = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, recordedAt: sameRecordedAt }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, aFallback2.id, QUERY_A);

    // QUERY_B 側は素直な1件（同点無し）。
    const b1 = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, b1.id, QUERY_B);

    // 両クエリのどちらにも中途半端な距離を持つ、無関係な filler。
    for (let i = 0; i < 5; i += 1) {
      const filler = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, filler.id, [0.5, 0.5, -0.5 - i * 0.01]);
    }

    const filter: VectorFilter = { tenantId: ctx.tenantId, status: ["active", "contested"] };
    const opts = { limit: 10, filter };

    const singleA = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_A, opts);
    const singleB = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_B, opts);

    const many = await vectorStore.searchMany(
      ctx,
      TEST_EMBEDDING_SPACE,
      [
        { key: "anchor-a", vector: QUERY_A },
        { key: "anchor-b", vector: QUERY_B },
      ],
      opts,
    );

    // 検算: 同点が実際に起きていること（この歯が何も検査していない、にならないため）。
    // 距離0の4件（recorded_at DESC → memory_id フォールバック）が必ず先頭に来る——
    // 最新の recorded_at を持つ aFallback1/aFallback2（同点、memory_id の辞書順）→
    // aNewer → aOlder の順（`vector-search-tiebreak.test.ts` と同じ既知の残余、ADR 0170）。
    expect(singleA.slice(0, 4).map((h) => h.distance)).toEqual([0, 0, 0, 0]);
    expect(singleA.slice(0, 4).map((h) => h.memoryId)).toEqual([
      ...[aFallback1.id, aFallback2.id].sort(),
      aNewer.id,
      aOlder.id,
    ]);

    expect(many.get("anchor-a")).toEqual(singleA);
    expect(many.get("anchor-b")).toEqual(singleB);
    // Map の key は queries と一致する——余計な key も欠落も無い。
    expect([...many.keys()].sort()).toEqual(["anchor-a", "anchor-b"]);
  }, 60_000);

  it("歯2: subjectId・attributes フィルタが効いた状態でも search() と一致する", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: `svm-filter-${Date.now()}` };

    const QUERY: number[] = [1, 0, 0];

    // 絞り込みに合致する候補。
    const matching = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "subject-x",
        attributes: { team: "alpha" },
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, matching.id, QUERY);

    // subjectId が違う——絞り込みで落ちるはず。
    const wrongSubject = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "subject-y",
        attributes: { team: "alpha" },
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, wrongSubject.id, QUERY);

    // attributes が違う——絞り込みで落ちるはず。
    const wrongAttributes = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "subject-x",
        attributes: { team: "beta" },
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, wrongAttributes.id, QUERY);

    const filter: VectorFilter = {
      tenantId: ctx.tenantId,
      status: ["active", "contested"],
      subjectId: "subject-x",
      attributes: { team: "alpha" },
    };
    const opts = { limit: 10, filter };

    const single = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY, opts);
    const many = await vectorStore.searchMany(
      ctx,
      TEST_EMBEDDING_SPACE,
      [{ key: "only-anchor", vector: QUERY }],
      opts,
    );

    // 検算: フィルタが実際に効いていること（絞り込みが無効化されていない）。
    expect(single.map((h) => h.memoryId)).toEqual([matching.id]);

    expect(many.get("only-anchor")).toEqual(single);
  }, 60_000);

  it("歯3: 空配列を渡すと往復を発生させずに空の Map を返す", async () => {
    const { db } = await getTestClient();
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: `svm-empty-${Date.now()}` };

    let result: Map<string, unknown> | undefined;
    const roundtrips = await countClientQueries(async () => {
      result = await vectorStore.searchMany(ctx, TEST_EMBEDDING_SPACE, [], {
        limit: 10,
        filter: { tenantId: ctx.tenantId },
      });
    });

    expect(result?.size).toBe(0);
    expect(roundtrips).toBe(0);
  }, 60_000);

  it("歯4（EXPLAIN）: searchMany が実際に発行する SQL は、LATERAL の中で HNSW 索引を使う", async () => {
    const TENANT = `svm-hnsw-${Date.now()}`;
    const ROW_COUNT = 3000;
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const rand = seededRandom(20260926);
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
    }
    // vector-search-hnsw.test.ts と同じ理由（ANALYZE 無しでは HNSW が選ばれない）。
    await pool.query(`ANALYZE ${TABLE}`);
    await pool.query("ANALYZE memories");

    const captured = await captureClientQuery(
      (text) => text.includes(TABLE) && /lateral/i.test(text),
      () =>
        vectorStore.searchMany(
          ctx,
          TEST_EMBEDDING_SPACE,
          [
            { key: "anchor-1", vector: [0.5, 0.5, 0.5] },
            { key: "anchor-2", vector: [0.1, 0.9, 0.2] },
            { key: "anchor-3", vector: [0.9, 0.1, 0.8] },
          ],
          { limit: 10, filter: { tenantId: TENANT } },
        ),
    );

    const plan = await explainCaptured(pool, captured);
    // ⚠ この assert はプランナの選択を見ている——版・統計・データ規模に依存する
    // （`vector-search-hnsw.test.ts` の同種の注記と同じ断り）。
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 120_000);
});
