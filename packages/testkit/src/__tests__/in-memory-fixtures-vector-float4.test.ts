import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore, InMemoryVectorStore } from "../fixtures.js";

const ctx: Ctx = { tenantId: "vector-float4" };
const space: EmbeddingSpaceId = { provider: "test", model: "float4", dimensions: 3 };

async function storeWith(vector: number[]) {
  const memoryStore = new InMemoryMemoryStore();
  const vectorStore = new InMemoryVectorStore(memoryStore);
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "v",
      content: "v",
      embeddingStatus: "ready",
    }),
  );
  await vectorStore.upsert(ctx, space, memory.id, vector);
  return { vectorStore, memoryId: memory.id };
}

describe("InMemoryVectorStore: ベクトルは float4 に丸めて持つ", () => {
  it("getVectors は保存したベクトルを float4 に丸めた値で返す", async () => {
    const vector = [0.1, 1 / 3, 1e-9];
    const { vectorStore, memoryId } = await storeWith(vector);
    const [entry] = await vectorStore.getVectors(ctx, space, [memoryId]);
    expect(entry!.vector).toEqual(vector.map(Math.fround));
    expect(entry!.vector[0]).not.toBe(0.1);
  });

  it("クエリも float4 に丸めて比べる（丸めると同じになるクエリは、同じ距離を返す）", async () => {
    const { vectorStore } = await storeWith([1, 0, 0]);
    const search = async (query: number[]) =>
      (
        await vectorStore.search(ctx, space, query, {
          limit: 1,
          filter: { tenantId: ctx.tenantId },
        })
      )[0]!.distance;
    expect(await search([1, 0.1 + 1e-9, 0])).toBe(await search([1, 0.1, 0]));
  });
});
