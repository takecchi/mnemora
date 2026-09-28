import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * `VectorStore` の TSDoc が約束する端の振る舞いを、`InMemoryVectorStore` について縛る。振る舞いは変えていない。
 *
 * - `VectorFilter.status`: 「⚠ 空配列なら1件も通らない（`@mnemora/postgres` と testkit の fixture で同じ）」。
 * - `VectorHit.distance`: 「コサイン距離は逆向き（cosine similarity = -1）のとき最大 2 まで出る」。
 * - `VectorStore.search`: 「`query` が有限でない成分（`NaN`・`Infinity`）を含むときも同じく『比較不能』であり、
 *   `search` は例外を投げない」。候補は落とさず、距離を比較の通らない値にして返す。
 *
 * このテストは fixture を直接呼ぶだけで、`*-conformance.ts` には触れていない（Issue #809）。
 */

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
