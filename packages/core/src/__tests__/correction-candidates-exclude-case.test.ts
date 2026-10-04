import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `findCorrectionCandidates` の `excludeMemoryIds` は、大文字小文字を無視して突き合わせる
 * （`CorrectionCandidatesInput.excludeMemoryIds` の TSDoc。ADR 0485 の PR 本文「大文字の除外」）。
 * `correction-candidates-exclude-edges.test.ts` は「渡した id が大文字」の向きだけを縛っている。この歯は逆向き——
 * store が返す記憶の id が大文字を含み、渡した id が小文字のときも除外される（adapter が id を大文字で返しても効く）。
 * core の Fake は id を小文字の `mem-N` で返すので、`getMany` の口だけを差し替えて、返す記憶の `id` を大文字にする。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const QUERY_TEXT = "seed";

function newMemory(): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
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
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
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
  const memoryStore = Object.create(stores.memoryStore) as typeof stores.memoryStore;
  const upper = (m: Memory): Memory => ({ ...m, id: m.id.toUpperCase() });
  Object.assign(memoryStore, {
    getMany: async (c: Ctx, ids: string[]) => (await stores.memoryStore.getMany(c, ids)).map(upper),
  });
  // 段1の候補の id も大文字にそろえる（recall は候補の id で記憶を引き直し、`id` が食い違うと候補を落とす）。
  const vectorStore = Object.create(stores.vectorStore) as typeof stores.vectorStore;
  Object.assign(vectorStore, {
    search: async (...args: Parameters<typeof stores.vectorStore.search>) =>
      (await stores.vectorStore.search(...args)).map((hit) => ({
        ...hit,
        memoryId: hit.memoryId.toUpperCase(),
      })),
  });
  const runtime = createRuntime({
    memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const near = await stores.memoryStore.createMemory(ctx, newMemory());
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, near.id, [8, 0]);
  return { runtime, near };
}

describe("findCorrectionCandidates: store が大文字の id を返すときも、小文字で渡した除外が効く", () => {
  it("対照: 除外しなければ、大文字の id の候補が返る（歯の前提）", async () => {
    const { runtime, near } = await setup();
    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });
    expect(result.candidates.map((c) => c.memoryId)).toEqual([near.id.toUpperCase()]);
  });

  it("小文字で渡した除外が、大文字の id の候補を落とす", async () => {
    const { runtime, near } = await setup();
    const result = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [near.id],
    });
    expect(result.excludedCount).toBe(1);
    expect(result.candidates).toEqual([]);
  });
});
