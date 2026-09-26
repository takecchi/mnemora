import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `observe({kind:'memory_usage'})` は、`recordUsage` が**新しく記録できた** id
 * （`insertedMemoryIds`）だけを強化する——同じ recall について既に記録済みの id を、別の
 * 使用報告で重ねて渡しても、もう一度は強化しない。
 *
 * 約束: `MemoryStore` の interface doc（`recordUsage`）と docs/memory-model.md §6
 * 「実際に挿入が起きたときだけ強化する」。
 *
 * 変異試験で、`recordUsageAndReinforce` を持たない adapter の経路（2段の経路）で強化に
 * `usedMemoryIds` をそのまま渡す変異がすり抜けた（既存の歯は、同じ externalId の再送——
 * 挿入が0件で強化自体が呼ばれない形——しか見ていなかった）。両方の経路で押さえる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const T1 = new Date("2026-06-01T00:00:00.000Z");
const T2 = new Date("2026-06-02T00:00:00.000Z");

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
    recordedAt: T1,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: T1,
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

async function setup(opts: { atomic: boolean }) {
  const stores = createFakeRuntimeStores();
  if (!opts.atomic) {
    // `recordUsageAndReinforce` を持たない adapter の経路（recordUsage → reinforceMany の2段）。
    (stores.memoryStore as { recordUsageAndReinforce?: unknown }).recordUsageAndReinforce =
      undefined;
  }
  let now = T1;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => now },
  });
  const a = await stores.memoryStore.createMemory(ctx, newMemory());
  const b = await stores.memoryStore.createMemory(ctx, newMemory());
  const recall = await runtime.recall(ctx, { vector: [1, 0], limit: 10, association: null });
  return { runtime, stores, a, b, recallId: recall.recallId, advance: () => (now = T2) };
}

describe.each([
  { atomic: true, label: "recordUsageAndReinforce の経路" },
  { atomic: false, label: "recordUsage → reinforceMany の2段の経路" },
])(
  "observe({kind:'memory_usage'}) は新しく記録できた id だけを強化する（$label）",
  ({ atomic }) => {
    it("既に記録済みの id を別の使用報告で重ねて渡しても、もう一度は強化しない", async () => {
      const { runtime, stores, a, b, recallId, advance } = await setup({ atomic });

      await runtime.observe(ctx, {
        kind: "memory_usage",
        recallId,
        usedMemoryIds: [a.id],
        externalId: "usage-1",
      });
      advance();
      const second = await runtime.observe(ctx, {
        kind: "memory_usage",
        recallId,
        usedMemoryIds: [a.id, b.id],
        externalId: "usage-2",
      });

      expect(second.memoryIds).toEqual([b.id]);
      expect((await stores.memoryStore.get(ctx, a.id))?.lastReinforcedAt).toEqual(T1);
      expect((await stores.memoryStore.get(ctx, b.id))?.lastReinforcedAt).toEqual(T2);
    });
  },
);
