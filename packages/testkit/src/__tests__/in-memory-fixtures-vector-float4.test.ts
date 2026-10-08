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

describe("InMemoryVectorStore.upsert: float4 の最大値の境目は、丸めた値で決まる", () => {
  const FLOAT4_MAX = 3.4028234663852886e38;
  // 最大値より大きいが、float4 へ丸めると最大値になる値（pgvector も最大値として受ける）。
  const JUST_BELOW_OVERFLOW = 3.4028235677973362e38;
  // 最大値と、その次の（`Infinity` になる）値の真ん中。
  const OVERFLOW_AT = 3.4028235677973366e38;

  it("境目の前提（Math.fround の丸め方）", () => {
    expect(Math.fround(JUST_BELOW_OVERFLOW)).toBe(FLOAT4_MAX);
    expect(Math.fround(OVERFLOW_AT)).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([JUST_BELOW_OVERFLOW, -JUST_BELOW_OVERFLOW])(
    "丸めると最大値になる成分（%s）は断らず、最大値として保存する",
    async (x) => {
      const { vectorStore, memoryId } = await storeWith([x, 0, 0]);
      const [entry] = await vectorStore.getVectors(ctx, space, [memoryId]);
      expect(entry!.vector).toEqual([Math.sign(x) * FLOAT4_MAX, 0, 0]);
    },
  );

  it.each([OVERFLOW_AT, -OVERFLOW_AT])("Infinity に丸まる成分（%s）は断る", async (x) => {
    await expect(storeWith([x, 0, 0])).rejects.toThrow(/does not fit in a float4/);
  });
});
