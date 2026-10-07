import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { Provenance } from "../provenance.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `memory-store-conformance.ts` には足さない: 外部 adapter へ要求を増やさないため。 */

const ctx: Ctx = { tenantId: "tenant-1" };
let counter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  counter += 1;
  const recordedAt = new Date("2026-06-01T00:00:00.000Z");
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `agg-exclude-prov-${counter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: null,
    embeddingStatus: "ready",
    ...overrides,
  } as NewMemory;
}

const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };

async function seed() {
  const { memoryStore } = createFakeRuntimeStores();
  await memoryStore.createMemory(ctx, newMemory());
  await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
  await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
  await memoryStore.createMemory(
    ctx,
    newMemory({ provenance: consolidated, embeddingStatus: "pending" }),
  );
  return memoryStore;
}

describe("FakeMemoryStore.aggregateScope: options.excludeProvenanceKinds（ADR 0390）", () => {
  it("除外 kind で索引済みの行の数を excludedProvenanceIndexedCount に返す（未索引は数えない）", async () => {
    const store = await seed();
    const aggregate = await store.aggregateScope(
      ctx,
      {},
      {
        excludeProvenanceKinds: ["consolidated"],
      },
    );
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    expect(aggregate.totalInScope).toBe(4);
  });

  it("空配列は no-op: 欄は返らず、返り値全体が指定なしと同じ", async () => {
    const store = await seed();
    const withEmpty = await store.aggregateScope(ctx, {}, { excludeProvenanceKinds: [] });
    const without = await store.aggregateScope(ctx, {});
    expect(withEmpty).toEqual(without);
    expect(withEmpty.excludedProvenanceIndexedCount).toBeUndefined();
    expect(withEmpty.totalInScope).toBe(without.totalInScope);
    expect(withEmpty.groups).toEqual(without.groups);
  });
});
