import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "vector-contract-edges" };
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };

async function seed(vector: number[]) {
  const memoryStore = new InMemoryMemoryStore();
  const vectorStore = new InMemoryVectorStore(memoryStore);
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, embeddingStatus: "ready" }),
  );
  await vectorStore.upsert(ctx, SPACE, memory.id, vector);
  return { vectorStore, memory };
}

describe("InMemoryVectorStore: VectorStore の TSDoc の端", () => {
  it("filter.status: [] なら1件も通らない（status を省略すれば同じ行が返る）", async () => {
    const { vectorStore, memory } = await seed([1, 0, 0]);

    const unfiltered = await vectorStore.search(ctx, SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    const empty = await vectorStore.search(ctx, SPACE, [1, 0, 0], {
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

    const hits = await vectorStore.search(ctx, SPACE, [-1, 0, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
    expect(hits[0]!.distance).toBeCloseTo(2, 5);
  });

  it.each([
    ["NaN", [Number.NaN, 0, 0]],
    ["Infinity", [Number.POSITIVE_INFINITY, 0, 0]],
    ["-Infinity", [0, Number.NEGATIVE_INFINITY, 0]],
  ])(
    "query に %s を含んでも投げず、候補を落とさず、距離は比較が通らない値になる",
    async (_label, query) => {
      const { vectorStore, memory } = await seed([1, 0, 0]);

      const hits = await vectorStore.search(ctx, SPACE, query, {
        limit: 10,
        filter: { tenantId: ctx.tenantId },
      });

      expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
      const distance = hits[0]!.distance;
      expect(distance >= 0).toBe(false);
      expect(distance <= 0).toBe(false);
    },
  );
});
