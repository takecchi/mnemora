import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "vector-space-exact-match" };
const OWN: EmbeddingSpaceId = { provider: "p", model: "m", dimensions: 3 };

describe("testkit の InMemoryVectorStore は、空間の3欄を完全一致で比べる", () => {
  it.each<[string, EmbeddingSpaceId]>([
    ["dimensions だけ違う", { provider: "p", model: "m", dimensions: 4 }],
    ["provider だけ違う", { provider: "q", model: "m", dimensions: 3 }],
    ["model だけ違う（前方一致する名前）", { provider: "p", model: "m:3", dimensions: 3 }],
  ])("%s空間のベクトルを、検索が返さない", async (_label, other) => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "space-exact" }),
    );
    const vector = Array.from({ length: other.dimensions }, (_, i) => (i === 0 ? 1 : 0));
    await vectorStore.upsert(ctx, other, memory.id, vector);

    const hits = await vectorStore.search(ctx, OWN, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    expect(hits).toEqual([]);
    const own = await vectorStore.search(ctx, other, vector, {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    expect(own.map((hit) => hit.memoryId)).toEqual([memory.id]);
  });
});
