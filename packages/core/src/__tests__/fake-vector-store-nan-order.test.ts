import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeVectorStore.search` が距離 `NaN`（ゼロベクトル、ADR 0040）の候補を
 * `PostgresVectorStore.search` と同じく常に最後尾へ置くこと（Issue #983）。
 * `packages/testkit/src/__tests__/in-memory-vector-store-nan-order.test.ts` と同じ入力。
 */
const TENANT = "vector-search-nan-order-tenant";
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };
const QUERY_VECTOR: number[] = [1, 0, 0];
const FINITE_VECTORS: number[][] = [
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [-1, 1, 0],
];
const ZERO_VECTOR: number[] = [0, 0, 0];

function fixture(overrides: Partial<NewMemory> & { recordedAt: Date }): NewMemory {
  const strength = 1;
  const halfLifeHours = 720;
  return {
    tenantId: TENANT,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "テスト用の本文",
    contentHash: `fixture-hash-${overrides.recordedAt.getTime()}-${Math.random()}`,
    digest: "テスト用の要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: overrides.recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

async function searchWithZeroAt(zeroPosition: number, limit: number) {
  const { memoryStore, vectorStore } = createFakeRuntimeStores();
  const ctx: Ctx = { tenantId: TENANT };
  const vectors = [...FINITE_VECTORS];
  vectors.splice(zeroPosition, 0, ZERO_VECTOR);
  let zeroId: string | undefined;
  const finiteIds: string[] = [];
  for (const [i, vector] of vectors.entries()) {
    const memory = await memoryStore.createMemory(
      ctx,
      fixture({ recordedAt: new Date(Date.UTC(2026, 0, 1 + i)) }),
    );
    await vectorStore.upsert(ctx, SPACE, memory.id, vector);
    if (vector === ZERO_VECTOR) zeroId = memory.id;
    else finiteIds.push(memory.id);
  }
  const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, {
    limit,
    filter: { tenantId: TENANT, status: ["active", "contested"] },
  });
  return { hits, zeroId: zeroId!, finiteIds };
}

describe("FakeVectorStore.search — 距離 NaN の候補は常に最後尾（Issue #983、PostgresVectorStore と同じ）", () => {
  it.each([0, 1, 2, 3, 4])(
    "ゼロベクトルを %i 番目に入れても、最後尾に返る",
    async (zeroPosition) => {
      const { hits, zeroId, finiteIds } = await searchWithZeroAt(zeroPosition, 10);
      expect(hits.map((h) => h.memoryId)).toEqual([...finiteIds, zeroId]);
      expect(Number.isNaN(hits[4]!.distance)).toBe(true);
    },
  );

  it.each([0, 1, 2, 3, 4])(
    "ゼロベクトルを %i 番目に入れても、limit が有限の候補の数ちょうどなら有限の候補だけが返る",
    async (zeroPosition) => {
      const { hits, finiteIds } = await searchWithZeroAt(zeroPosition, FINITE_VECTORS.length);
      expect(hits.map((h) => h.memoryId)).toEqual(finiteIds);
    },
  );
});
