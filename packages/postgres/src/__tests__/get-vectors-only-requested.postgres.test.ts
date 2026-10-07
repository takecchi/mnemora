import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const ctx: Ctx = { tenantId: `get-vectors-only-requested-${randomUUID()}` };

async function seed() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const add = async (vector: number[]) => {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `get-vectors-${randomUUID()}`,
        embeddingStatus: "ready",
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
    return memory;
  };
  const x = await add([1, 0, 0]);
  const y = await add([0, 1, 0]);
  await add([0, 0, 1]);
  return { vectorStore, x, y };
}

describe("PostgresVectorStore.getVectors: 渡した id の分だけを返す", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("同じテナントに別の embedding があっても、渡した id のものしか返さない", async () => {
    const { vectorStore, x, y } = await seed();

    const onlyX = await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [x.id]);
    const xAndY = await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [x.id, y.id]);

    expect(onlyX.map((e) => e.memoryId)).toEqual([x.id]);
    expect(xAndY.map((e) => e.memoryId).sort()).toEqual([x.id, y.id].sort());
  });

  it("形式の合わない id は、無い id と同じく静かに落ちる", async () => {
    const { vectorStore, x } = await seed();

    const mixed = await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [
      "not-a-uuid" as MemoryId,
      x.id,
    ]);
    const onlyMalformed = await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [
      "not-a-uuid" as MemoryId,
    ]);

    expect(mixed.map((e) => e.memoryId)).toEqual([x.id]);
    expect(onlyMalformed).toEqual([]);
  });
});
