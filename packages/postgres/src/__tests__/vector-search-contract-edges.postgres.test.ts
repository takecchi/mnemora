import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `VectorStore` の TSDoc が約束する端の振る舞いを、`PostgresVectorStore.search` について縛る。
 *
 * - `VectorFilter.status`: 「⚠ 空配列なら1件も通らない（`@mnemora/postgres` と testkit の fixture で同じ）」。
 * - `VectorHit.distance`: 「コサイン距離は逆向き（cosine similarity = -1）のとき最大 2 まで出る」。
 */

const ctx: Ctx = { tenantId: `vector-contract-edges-${randomUUID()}` };

async function seed(vector: number[]) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `edges-${randomUUID()}`,
      embeddingStatus: "ready",
    }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return { vectorStore, memory };
}

describe("PostgresVectorStore.search: VectorStore の TSDoc の端", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("filter.status: [] なら1件も通らない（status を省略すれば同じ行が返る）", async () => {
    const { vectorStore, memory } = await seed([1, 0, 0]);

    const unfiltered = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    const empty = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId, status: [] },
    });

    expect({
      unfiltered: unfiltered.map((h) => h.memoryId),
      empty: empty.map((h) => h.memoryId),
    }).toEqual({ unfiltered: [memory.id], empty: [] });
  });

  it("distance: 逆向きのベクトルでは約 2（0〜1 に収めない）", async () => {
    const { vectorStore, memory } = await seed([1, 0, 0]);

    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [-1, 0, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
    expect(hits[0]!.distance).toBeCloseTo(2, 5);
  });
});
