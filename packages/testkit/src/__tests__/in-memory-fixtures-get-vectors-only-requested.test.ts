import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const otherCtx: Ctx = { tenantId: "tenant-2" };
const SPACE = { provider: "test", model: "fixture-model", dimensions: 3 };

async function seed() {
  const memoryStore = new InMemoryMemoryStore();
  const vectorStore = new InMemoryVectorStore(memoryStore);
  const add = async (c: Ctx, hash: string, vector: number[]) => {
    const memory = await memoryStore.createMemory(
      c,
      buildNewMemoryFixture({ tenantId: c.tenantId, contentHash: hash }),
    );
    await vectorStore.upsert(c, SPACE, memory.id, vector);
    return memory;
  };
  const x = await add(ctx, "x", [1, 0, 0]);
  const y = await add(ctx, "y", [0, 1, 0]);
  const z = await add(ctx, "z", [0, 0, 1]);
  const foreign = await add(otherCtx, "foreign", [1, 1, 0]);
  return { vectorStore, x, y, z, foreign };
}

describe("InMemoryVectorStore.getVectors: 渡した id の分だけを返す", () => {
  it("同じテナントに別の embedding があっても、渡した id のものしか返さない", async () => {
    const { vectorStore, x, y } = await seed();

    const onlyX = await vectorStore.getVectors(ctx, SPACE, [x.id]);
    const xAndY = await vectorStore.getVectors(ctx, SPACE, [x.id, y.id]);

    expect(onlyX.map((e) => e.memoryId)).toEqual([x.id]);
    expect(xAndY.map((e) => e.memoryId).sort()).toEqual([x.id, y.id].sort());
  });

  it("形式の合わない id は、無い id と同じく静かに落ちる", async () => {
    const { vectorStore, x } = await seed();

    const mixed = await vectorStore.getVectors(ctx, SPACE, ["not-a-uuid" as typeof x.id, x.id]);
    const onlyMalformed = await vectorStore.getVectors(ctx, SPACE, ["not-a-uuid" as typeof x.id]);

    expect(mixed.map((e) => e.memoryId)).toEqual([x.id]);
    expect(onlyMalformed).toEqual([]);
  });
});
