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

const ctx: Ctx = { tenantId: `vector-store-stored-values-${randomUUID()}` };

async function setup() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const add = (attributes: Record<string, string>) =>
    memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `stored-values-${randomUUID()}`,
        embeddingStatus: "ready",
        attributes,
      }),
    );
  return { vectorStore, add };
}

describe("PostgresVectorStore — 保存されているベクトルと未指定の filter", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("getVectors: 全成分 0 で保存したベクトルも、ゼロのまま返す", async () => {
    const { vectorStore, add } = await setup();
    const zero = await add({});
    const nonZero = await add({});
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, zero.id, [0, 0, 0]);
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, nonZero.id, [1, 0, 0]);

    const entries = await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [zero.id, nonZero.id]);

    const byId = new Map(entries.map((e) => [e.memoryId, e.vector]));
    expect(byId.get(zero.id)).toEqual([0, 0, 0]);
    expect(byId.get(nonZero.id)).toEqual([1, 0, 0]);
  });

  it("search / searchMany: filter.attributes が空オブジェクトなら、attributes が空の記憶も空でない記憶も返る", async () => {
    const { vectorStore, add } = await setup();
    const empty = await add({});
    const filled = await add({ team: "alpha" });
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, empty.id, [1, 0, 0]);
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, filled.id, [0.9, 0.1, 0]);
    const opts = { limit: 10, filter: { tenantId: ctx.tenantId, attributes: {} } };
    const expected = [empty.id, filled.id].sort();

    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], opts);
    const many = await vectorStore.searchMany!(
      ctx,
      TEST_EMBEDDING_SPACE,
      [{ key: "q", vector: [1, 0, 0] }],
      opts,
    );

    expect(hits.map((h) => h.memoryId).sort()).toEqual(expected);
    expect(
      many
        .get("q")!
        .map((h) => h.memoryId)
        .sort(),
    ).toEqual(expected);
  });
});
