import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.aggregateScope` の `options.excludeProvenanceKinds`（ADR 0390）が返す
 * 任意の欄 `excludedProvenanceIndexedCount`（「除外される kind で、索引済み
 * （embeddingStatus='ready'）の行の数」）の歯。`InMemoryMemoryStore` 側は
 * `packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts`。
 * **`memory-store-conformance.ts` には足さない**（Issue #809 の方針。外部 adapter へ要求を増やさない。
 * `fake-aggregate-scope-include-subjectless.test.ts` と同じ理由・同じ形）。
 * `totalInScope`・`groups` は除外を渡しても変わらない（意味を動かさない）ことも固定する。
 */

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

const consolidated = { kind: "consolidated", sources: ["a", "b"] } as const;

async function seed() {
  const { memoryStore } = createFakeRuntimeStores();
  await memoryStore.createMemory(ctx, newMemory());
  await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
  await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
  // 未索引（pending）の除外 kind の行は「索引済み」に数えない。
  await memoryStore.createMemory(
    ctx,
    newMemory({ provenance: consolidated, embeddingStatus: "pending" }),
  );
  return memoryStore;
}

describe("FakeMemoryStore.aggregateScope: options.excludeProvenanceKinds（ADR 0390）", () => {
  it("除外 kind で索引済みの行の数を excludedProvenanceIndexedCount に返す（未索引は数えない）", async () => {
    const store = await seed();
    const aggregate = await store.aggregateScope(ctx, {}, {
      excludeProvenanceKinds: ["consolidated"],
    } as never);
    expect(
      (aggregate as { excludedProvenanceIndexedCount?: number }).excludedProvenanceIndexedCount,
    ).toBe(2);
    // totalInScope の意味は変えない（除外行も数える）。
    expect(aggregate.totalInScope).toBe(4);
  });

  it("空配列は no-op: 欄は返らない（または 0）で、totalInScope も変わらない", async () => {
    const store = await seed();
    const withEmpty = await store.aggregateScope(ctx, {}, { excludeProvenanceKinds: [] } as never);
    const without = await store.aggregateScope(ctx, {});
    expect(
      (withEmpty as { excludedProvenanceIndexedCount?: number }).excludedProvenanceIndexedCount ??
        0,
    ).toBe(0);
    expect(withEmpty.totalInScope).toBe(without.totalInScope);
    expect(withEmpty.groups).toEqual(without.groups);
  });
});
