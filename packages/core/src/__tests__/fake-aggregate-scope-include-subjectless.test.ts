import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `memory-store-conformance.ts` には足さない: `FakeMemoryStore` は core の runtime テスト専用の別系統のため。 */

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `aggregate-scope-subjectless-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.aggregateScope の scope.includeSubjectless（ADR 0286、Issue #768）", () => {
  it("includeSubjectless: true なら、一致する subject と主題なし（null）の両方を totalInScope に含める", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, newMemory({ subjectId: "user-1" }));
    await memoryStore.createMemory(ctx, newMemory({ subjectId: null }));
    await memoryStore.createMemory(ctx, newMemory({ subjectId: "user-2" }));

    const aggregate = await memoryStore.aggregateScope(ctx, {
      subjectId: "user-1",
      includeSubjectless: true,
    });

    expect(aggregate.totalInScope).toBe(2);
    expect(aggregate.groups).toContainEqual(
      expect.objectContaining({ axis: "subject", key: "user-1", count: 1 }),
    );
    expect(aggregate.groups).toContainEqual(
      expect.objectContaining({ axis: "subject", key: null, count: 1 }),
    );
    expect(aggregate.groups).not.toContainEqual(
      expect.objectContaining({ axis: "subject", key: "user-2" }),
    );
  });

  it("includeSubjectless: 省略/false なら、主題なし（null）は従来どおり totalInScope に含めない（回帰）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, newMemory({ subjectId: "user-1" }));
    await memoryStore.createMemory(ctx, newMemory({ subjectId: null }));

    const omitted = await memoryStore.aggregateScope(ctx, { subjectId: "user-1" });
    const explicitFalse = await memoryStore.aggregateScope(ctx, {
      subjectId: "user-1",
      includeSubjectless: false,
    });

    expect(omitted.totalInScope).toBe(1);
    expect(explicitFalse.totalInScope).toBe(1);
  });

  it("subjectId 無しで includeSubjectless: true が渡っても、テナント全体（絞りなし）と同じになる（回帰）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, newMemory({ subjectId: "user-1" }));
    await memoryStore.createMemory(ctx, newMemory({ subjectId: null }));

    const tenantWide = await memoryStore.aggregateScope(ctx, {});
    const withIncludeSubjectlessButNoSubjectId = await memoryStore.aggregateScope(ctx, {
      includeSubjectless: true,
    });

    expect(withIncludeSubjectlessButNoSubjectId.totalInScope).toBe(tenantWide.totalInScope);
    expect(tenantWide.totalInScope).toBe(2);
  });
});
