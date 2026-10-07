import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { ReinforceOptions } from "../interfaces/memory-store.js";
import { writeDecayClock } from "../interfaces/tenant-settings-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 既存の歯は再送で強化が完了するかしか見ず、渡す引数を見ない（`reinforceOpts` を渡さない実装はすり抜ける）ので、
// 強化の時刻と活動時計の読み（`ReinforceOptions`）を、従来の2段（`recordUsage` → `reinforceMany`）と同じ形で渡すことをここで見る。

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
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
    decayBaseSeq: 0,
    decayFloorSeq: 10,
    halfLifeRecalls: 360,
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

async function run(decayClock: "wall" | "activity", hideCombined: boolean) {
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
  await writeDecayClock(stores.tenantSettingsStore, ctx, decayClock);
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
  const calls: { at: Date; opts: ReinforceOptions | undefined }[] = [];
  const combined = stores.memoryStore.recordUsageAndReinforce!.bind(stores.memoryStore);
  const many = stores.memoryStore.reinforceMany!.bind(stores.memoryStore);
  if (hideCombined) {
    Object.defineProperty(stores.memoryStore, "recordUsageAndReinforce", {
      value: undefined,
      configurable: true,
    });
    stores.memoryStore.reinforceMany = async (c, ids, at, opts) => {
      calls.push({ at, opts });
      return many(c, ids, at, opts);
    };
  } else {
    stores.memoryStore.recordUsageAndReinforce = async (c, rid, ids, at, opts) => {
      calls.push({ at, opts });
      return combined(c, rid, ids, at, opts);
    };
  }
  await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId,
    usedMemoryIds: [memory.id],
    externalId: "usage-args-1",
  });
  return calls;
}

describe("observe({kind:'memory_usage'}): recordUsageAndReinforce へ渡す at・opts は、従来の2段と同じ（#980）", () => {
  for (const decayClock of ["wall", "activity"] as const) {
    it(`decay_clock=${decayClock}：強化の時刻は clock.now()、opts は従来の2段（reinforceMany）に渡すものと同じ`, async () => {
      const combined = await run(decayClock, false);
      const twoStep = await run(decayClock, true);
      expect(combined).toHaveLength(1);
      expect(twoStep).toHaveLength(1);
      expect(combined[0]!.at).toEqual(NOW);
      expect(combined[0]!.opts).toEqual(twoStep[0]!.opts);
      if (decayClock === "wall") {
        expect(combined[0]!.opts).toBeUndefined();
      } else {
        expect(combined[0]!.opts).toMatchObject({ nowSeq: expect.any(Number) });
      }
    });
  }
});
