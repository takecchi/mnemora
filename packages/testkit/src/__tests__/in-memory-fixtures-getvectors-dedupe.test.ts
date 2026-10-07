import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const SPACE = { provider: "test", model: "fixture-model", dimensions: 3 };

describe("InMemoryVectorStore.getVectors: memoryIds に重複があっても一意な id の集合しか返さない", () => {
  it("同じ id が複数回含まれていても、その id は1回だけ結果に現れる（重複させない）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const x = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-x" }),
    );
    await vectorStore.upsert(ctx, SPACE, x.id, [1, 0, 0]);

    const entries = await vectorStore.getVectors(ctx, SPACE, [x.id, x.id, x.id]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.memoryId).toBe(x.id);
  });

  it("複数の異なる id を混ぜても、それぞれ1回だけ結果に現れる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const x = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-x2" }),
    );
    const y = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-y2" }),
    );
    await vectorStore.upsert(ctx, SPACE, x.id, [1, 0, 0]);
    await vectorStore.upsert(ctx, SPACE, y.id, [0, 1, 0]);

    const entries = await vectorStore.getVectors(ctx, SPACE, [x.id, x.id, y.id]);

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.memoryId))).toEqual(new Set([x.id, y.id]));
  });
});
