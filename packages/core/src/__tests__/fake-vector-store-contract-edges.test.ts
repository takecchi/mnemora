import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `VectorStore` の TSDoc が約束する端の振る舞いを、`FakeVectorStore` について縛る。振る舞いは変えていない。
 *
 * - `VectorFilter.status`: 「⚠ 空配列なら1件も通らない」。
 * - `VectorHit.distance`: 「コサイン距離は逆向き（cosine similarity = -1）のとき最大 2 まで出る」。
 * - `VectorStore.search`: 「`query` が有限でない成分（`NaN`・`Infinity`）を含むときも同じく『比較不能』であり、
 *   `search` は例外を投げない」。候補は落とさず、距離を比較の通らない値にして返す。
 *
 * `FakeVectorStore` は適合試験（`vector-store-conformance.ts`）の対象ではない（`fake-vector-store-filter.test.ts`
 * 冒頭）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const space = { provider: "test", model: "fixture-model", dimensions: 3 };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `edges-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-06-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2020-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...overrides,
  };
}

async function seed(vector: number[]) {
  const stores = createFakeRuntimeStores();
  const memory = await stores.memoryStore.createMemory(ctx, newMemory());
  await stores.vectorStore.upsert(ctx, space, memory.id, vector);
  return { vectorStore: stores.vectorStore, memory };
}

describe("FakeVectorStore: VectorStore の TSDoc の端", () => {
  it("filter.status: [] なら1件も通らない（status を省略すれば同じ行が返る）", async () => {
    const { vectorStore, memory } = await seed([1, 0, 0]);

    const unfiltered = await vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    const empty = await vectorStore.search(ctx, space, [1, 0, 0], {
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

    const hits = await vectorStore.search(ctx, space, [-1, 0, 0], {
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

      const hits = await vectorStore.search(ctx, space, query, {
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
