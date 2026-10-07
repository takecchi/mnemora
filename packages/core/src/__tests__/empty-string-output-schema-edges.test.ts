import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { OutboxJobRecordSchema } from "../outbox.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import { takeRuntimeOutputContractProblemsForTesting } from "./runtime-output-contract-harness.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");

describe("空文字の subjectId で書いた記憶を recall() が返すと、outputValidation が ok: false になる", () => {
  it("返る RecalledMemory.subjectId は空文字のままで、issues は memories の subjectId を指す", async () => {
    const ctx: Ctx = { tenantId: "empty-subject" };
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      ...stores,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    const memory = await stores.memoryStore.createMemory(ctx, newMemory(ctx, { subjectId: "" }));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(takeRuntimeOutputContractProblemsForTesting().length).toBeGreaterThan(0);
    expect(result.memories.map((m) => m.subjectId)).toEqual([""]);
    expect(result.outputValidation?.ok).toBe(false);
    expect(result.outputValidation?.issues.map((issue) => issue.path)).toContain(
      "memories.0.subjectId",
    );
  });

  it("対照: 空でない subjectId の記憶は ok: true", async () => {
    const ctx: Ctx = { tenantId: "non-empty-subject" };
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      ...stores,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    const memory = await stores.memoryStore.createMemory(ctx, newMemory(ctx, { subjectId: "u1" }));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
  });
});

describe("OutboxJobRecordSchema は、空文字の tenantId・claimedBy のジョブを通さない", () => {
  const valid = {
    id: "job-1",
    tenantId: "t1",
    kind: "embed",
    payload: {},
    availableAt: NOW,
    claimedAt: NOW,
    claimedBy: "worker-1",
    attempts: 0,
    createdAt: NOW,
  };

  it("対照: 空文字を含まないジョブは通る", () => {
    expect(OutboxJobRecordSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["tenantId", { tenantId: "" }],
    ["claimedBy", { claimedBy: "" }],
  ])("空文字の %s は通さない", (_field, override) => {
    expect(OutboxJobRecordSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});

function newMemory(ctx: Ctx, overrides: Partial<NewMemory>): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
    }),
    embeddingStatus: "ready",
    ...overrides,
  };
}
