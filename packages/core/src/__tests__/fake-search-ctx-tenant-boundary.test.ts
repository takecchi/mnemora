import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 「一致すれば A 自身が返る」も同じ it で見る: 「常に空を返す」実装で緑にならないため。
 * `*-conformance.ts` には足さない。
 */

const TENANT_A = "fake-search-boundary-a";
const TENANT_B = "fake-search-boundary-b";
const ctxA: Ctx = { tenantId: TENANT_A };
const ctxB: Ctx = { tenantId: TENANT_B };
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };
const QUERY = "boundary probe token";

function newMemory(tenantId: string): NewMemory {
  return {
    tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `${QUERY} の記憶`,
    contentHash: `fake-search-boundary-${tenantId}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "ready",
  };
}

async function seed() {
  const { memoryStore, vectorStore, lexicalStore } = createFakeRuntimeStores();
  const ids: Record<string, string> = {};
  for (const ctx of [ctxA, ctxB]) {
    const memory = await memoryStore.createMemory(ctx, newMemory(ctx.tenantId));
    await vectorStore.upsert(ctx, SPACE, memory.id, [1, 0, 0]);
    ids[ctx.tenantId] = memory.id;
  }
  return { vectorStore, lexicalStore, idA: ids[TENANT_A]!, idB: ids[TENANT_B]! };
}

describe("core の Fake の search は ctx.tenantId の境界も掛ける（Issue #1050 / ADR 0007）", () => {
  it("FakeVectorStore.search: ctx と filter.tenantId が食い違えば、どちらのテナント側でも空。一致すればそのテナントだけ", async () => {
    const { vectorStore, idA, idB } = await seed();

    // ctx が B・filter が A（filter 側の行が出てはいけない）。
    expect(
      await vectorStore.search(ctxB, SPACE, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: TENANT_A },
      }),
    ).toEqual([]);
    // ctx が A・filter が B（ctx 側の行が出てはいけない）。
    expect(
      await vectorStore.search(ctxA, SPACE, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: TENANT_B },
      }),
    ).toEqual([]);

    const matched = await vectorStore.search(ctxA, SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(matched.map((h) => h.memoryId)).toEqual([idA]);
    expect(matched.map((h) => h.memoryId)).not.toContain(idB);
  });

  it("FakeLexicalStore.search: ctx と filter.tenantId が食い違えば、どちらのテナント側でも空。一致すればそのテナントだけ", async () => {
    const { lexicalStore, idA, idB } = await seed();

    expect(
      await lexicalStore.search(ctxB, QUERY, { limit: 10, filter: { tenantId: TENANT_A } }),
    ).toEqual([]);
    expect(
      await lexicalStore.search(ctxA, QUERY, { limit: 10, filter: { tenantId: TENANT_B } }),
    ).toEqual([]);

    const matched = await lexicalStore.search(ctxA, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(matched.map((h) => h.memoryId)).toEqual([idA]);
    expect(matched.map((h) => h.memoryId)).not.toContain(idB);
  });
});
