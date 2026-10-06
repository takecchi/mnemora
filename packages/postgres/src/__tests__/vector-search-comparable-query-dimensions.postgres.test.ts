import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * 比較できないクエリ（空配列・長さが違う・有限でない成分）は、`space.dimensions` 長の全 0 ベクトルに
 * 差し替わって投げずに「比較不能」になる。差し替え先の長さは、その空間の `space.dimensions` である。
 * 既存の歯は、どれも次元が 3 の空間（`TEST_EMBEDDING_SPACE`）だけを使うので、長さを 3 に決め打ちしても
 * 見分けがつかない。ここでは次元が 3 ではない空間で、同じ約束を縛る。
 */

const SPACE = { provider: "test", model: "comparable-query-dims-5", dimensions: 5 };

const BAD_QUERIES = [
  ["空配列", []],
  ["短い（3）", [1, 0, 0]],
  ["長い（6）", [1, 0, 0, 0, 0, 0]],
  ["有限でない成分", [Number.NaN, 0, 0, 0, 0]],
] as const;

/** テナントを毎回新しくして、1件だけ入った状態を作る。 */
async function seed() {
  const tenant = `comparable-query-dims-${randomUUID()}`;
  const ctx: Ctx = { tenantId: tenant };
  const { db, pool } = await getTestClient();
  await registerEmbeddingSpace(pool, SPACE);
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: tenant,
      contentHash: `comparable-query-dims-${randomUUID()}`,
      embeddingStatus: "ready",
    }),
  );
  await vectorStore.upsert(ctx, SPACE, memory.id, [1, 0, 0, 0, 0]);
  return { ctx, vectorStore, memory };
}

describe("次元が 3 ではない空間でも、比較できないクエリは投げずに比較不能になる", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it.each(BAD_QUERIES)(
    "search（%s）: 候補は残り、距離は比較の通らない値になる",
    async (_label, query) => {
      const { ctx, vectorStore, memory } = await seed();

      const hits = await vectorStore.search(ctx, SPACE, [...query], {
        limit: 10,
        filter: { tenantId: ctx.tenantId },
      });

      expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
      expect(hits[0]!.distance >= 0).toBe(false);
      expect(hits[0]!.distance <= 0).toBe(false);
    },
  );

  it.each(BAD_QUERIES)(
    "searchMany（%s）: 同じく比較不能になり、正常なクエリは影響を受けない",
    async (_label, query) => {
      const { ctx, vectorStore, memory } = await seed();

      const result = await vectorStore.searchMany(
        ctx,
        SPACE,
        [
          { key: "bad", vector: [...query] },
          { key: "good", vector: [1, 0, 0, 0, 0] },
        ],
        { limit: 10, filter: { tenantId: ctx.tenantId } },
      );

      const bad = result.get("bad")!;
      expect(bad.map((h) => h.memoryId)).toEqual([memory.id]);
      expect(bad[0]!.distance >= 0).toBe(false);
      expect(bad[0]!.distance <= 0).toBe(false);
      expect(result.get("good")).toEqual([{ memoryId: memory.id, distance: 0 }]);
    },
  );
});
