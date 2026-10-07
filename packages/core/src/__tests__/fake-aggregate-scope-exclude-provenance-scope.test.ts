import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { Provenance } from "../provenance.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };
const IN_PERIOD = new Date("2026-06-10T00:00:00.000Z");
const BEFORE_PERIOD = new Date("2026-01-01T00:00:00.000Z");
let counter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  counter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: "s1",
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `agg-exclude-prov-scope-${counter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: ["alpha"],
    occurredAt: null,
    recordedAt: IN_PERIOD,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...overrides,
  } as NewMemory;
}

const scope = {
  subjectId: "s1",
  labels: ["alpha"],
  occurredAfter: new Date("2026-06-01T00:00:00.000Z"),
};

describe("FakeMemoryStore.aggregateScope: excludedProvenanceIndexedCount は totalInScope と同じ絞りの内側だけを数える（Issue #1734 / PR #1458 のすり抜け）", () => {
  async function seed() {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
    await memoryStore.createMemory(
      ctx,
      newMemory({ provenance: consolidated, status: "archived" }),
    );
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated, subjectId: "s2" }));
    await memoryStore.createMemory(
      ctx,
      newMemory({ provenance: consolidated, recordedAt: BEFORE_PERIOD }),
    );
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated, tags: ["beta"] }));
    await memoryStore.createMemory(ctx, newMemory());
    return memoryStore;
  }

  it("archived・別 subject・期間の外・labels に合わない行は、除外 kind でも数えない", async () => {
    const store = await seed();
    const aggregate = await store.aggregateScope(ctx, scope, {
      excludeProvenanceKinds: ["consolidated"],
    });
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    // 対照: スコープ内の行は除外 kind の2件と、除外 kind でない1件（totalInScope の意味は変えない）
    expect(aggregate.totalInScope).toBe(3);
    expect(aggregate.filteredArchived.count).toBe(1);
  });
});
