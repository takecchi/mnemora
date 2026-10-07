import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT_A = "in-memory-search-boundary-a";
const TENANT_B = "in-memory-search-boundary-b";
const ctxA: Ctx = { tenantId: TENANT_A };
const ctxB: Ctx = { tenantId: TENANT_B };
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };
const QUERY = "boundary probe token";

async function seed() {
  const memoryStore = new InMemoryMemoryStore();
  const vectorStore = new InMemoryVectorStore(memoryStore);
  const lexicalStore = new InMemoryLexicalStore(memoryStore);
  const ids: Record<string, string> = {};
  for (const ctx of [ctxA, ctxB]) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `in-memory-search-boundary-${ctx.tenantId}`,
        content: `${QUERY} の記憶`,
      }),
    );
    await vectorStore.upsert(ctx, SPACE, memory.id, [1, 0, 0]);
    ids[ctx.tenantId] = memory.id;
  }
  return { vectorStore, lexicalStore, idA: ids[TENANT_A]! };
}

describe("InMemory の search は ctx.tenantId の境界も掛ける（Issue #1050 / ADR 0007）", () => {
  it("InMemoryVectorStore.search: ctx と filter.tenantId が食い違えば空、一致すればそのテナントだけ", async () => {
    const { vectorStore, idA } = await seed();

    const mismatched = await vectorStore.search(ctxB, SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(mismatched).toEqual([]);

    const matched = await vectorStore.search(ctxA, SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(matched.map((h) => h.memoryId)).toEqual([idA]);
  });

  it("InMemoryLexicalStore.search: ctx と filter.tenantId が食い違えば空、一致すればそのテナントだけ", async () => {
    const { lexicalStore, idA } = await seed();

    const mismatched = await lexicalStore.search(ctxB, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(mismatched).toEqual([]);

    const matched = await lexicalStore.search(ctxA, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(matched.map((h) => h.memoryId)).toEqual([idA]);
  });

  it("食い違っていても limit の検査は先に効く（Postgres が SQL の LIMIT で例外を投げるのと揃える）", async () => {
    const { vectorStore, lexicalStore } = await seed();

    await expect(
      vectorStore.search(ctxB, SPACE, [1, 0, 0], { limit: -1, filter: { tenantId: TENANT_A } }),
    ).rejects.toThrow("limit must not be negative");
    await expect(
      lexicalStore.search(ctxB, QUERY, { limit: -1, filter: { tenantId: TENANT_A } }),
    ).rejects.toThrow("limit must not be negative");
  });
});
