import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

import type { NewMemory } from "../memory.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
// 作成時刻は最初の強化より前に置く: reinforce は起点（lastReinforcedAt ?? recordedAt）より新しい at だけを
// 書くので、作成と同じミリ秒の強化は書かれない。
const RECORDED_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

function newMemory(): NewMemory {
  return {
    tenantId: "tenant-1",
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
    recordedAt: RECORDED_AT,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: RECORDED_AT,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365,
    }),
    embeddingStatus: "ready",
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

async function setup() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const memory = await stores.memoryStore.createMemory(ctx, newMemory());
  const recallId = await stores.memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "fixture" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
  });
  const originalReinforceMany = stores.memoryStore.reinforceMany.bind(stores.memoryStore);
  let reinforceCalls = 0;
  stores.memoryStore.reinforceMany = async (...args) => {
    reinforceCalls += 1;
    if (reinforceCalls === 1) {
      throw new Error("simulated connection reset during reinforce");
    }
    return originalReinforceMany(...args);
  };
  const input = {
    kind: "memory_usage" as const,
    recallId,
    usedMemoryIds: [memory.id],
    externalId: "usage-1",
  };
  return { runtime, stores, memory, input };
}

describe("observe({kind:'memory_usage'}) の記録と強化（Issue #961）", () => {
  it("recordUsageAndReinforce が在れば、強化の失敗で記録も残らず、同じ externalId の再送で強化が完了する", async () => {
    const { runtime, stores, memory, input } = await setup();

    await expect(runtime.observe(ctx, input)).rejects.toThrow(
      "simulated connection reset during reinforce",
    );
    const resent = await runtime.observe(ctx, input);

    expect(resent.memoryIds).toEqual([memory.id]);
    expect((await stores.memoryStore.get(ctx, memory.id))?.lastReinforcedAt).toEqual(NOW);
  });

  it("recordUsageAndReinforce が無い adapter では従来の2段のまま——再送でも強化されない窓が残る（負債）", async () => {
    const { runtime, stores, memory, input } = await setup();
    Object.defineProperty(stores.memoryStore, "recordUsageAndReinforce", {
      value: undefined,
      configurable: true,
    });

    await expect(runtime.observe(ctx, input)).rejects.toThrow(
      "simulated connection reset during reinforce",
    );
    const resent = await runtime.observe(ctx, input);

    expect(resent.memoryIds).toEqual([]);
    expect((await stores.memoryStore.get(ctx, memory.id))?.lastReinforcedAt ?? null).toBeNull();
  });
});
