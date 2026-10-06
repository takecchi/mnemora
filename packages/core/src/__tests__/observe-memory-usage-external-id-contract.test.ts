import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `observe({ kind: "memory_usage", externalId })` の約束のうち、次の4つを縛る。
 * - 同じ `externalId` で違う中身が来ても、保存済みの中身が使われ、後着は無視される
 *   （使用の記録・強化のどちらの経路でも）。
 * - `externalId` は Observation 行の列で、payload には入らない。
 * - 別の kind（utterance・event・document のどれでも）と `externalId` が衝突したら、使用を記録せず、
 *   その Observation の id を `memoryIds: []`・`extraction: "skipped"` で返す。
 * - `externalId` は空文字を断り、1文字は受ける（他の3種と同じ規約）。
 */

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
  const memoryA = await stores.memoryStore.createMemory(ctx, newMemory());
  const memoryB = await stores.memoryStore.createMemory(ctx, newMemory());
  const recall = () =>
    stores.memoryStore.createRecall(ctx, {
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
  return { runtime, stores, memoryA, memoryB, recallA: await recall(), recallB: await recall() };
}

describe("memory_usage の再送: 同じ externalId で違う中身が来ても、保存済みの中身が使われる", () => {
  for (const [label, dropCombinedMethod] of [
    ["recordUsageAndReinforce が在る経路", false],
    ["recordUsageAndReinforce が無い2段の経路", true],
  ] as const) {
    it(`${label}`, async () => {
      const { runtime, stores, memoryA, memoryB, recallA, recallB } = await setup();
      if (dropCombinedMethod) {
        Object.defineProperty(stores.memoryStore, "recordUsageAndReinforce", {
          value: undefined,
          configurable: true,
        });
      }

      const first = await runtime.observe(ctx, {
        kind: "memory_usage",
        externalId: "usage-differs",
        recallId: recallA,
        usedMemoryIds: [memoryA.id],
      });
      expect(first.memoryIds).toEqual([memoryA.id]);

      const second = await runtime.observe(ctx, {
        kind: "memory_usage",
        externalId: "usage-differs",
        recallId: recallB,
        usedMemoryIds: [memoryB.id],
      });

      expect(second.observationId).toBe(first.observationId);
      expect(second.memoryIds).toEqual([]);
      // 後着の中身（recallB・memoryB）は記録も強化もされない。
      expect((await stores.memoryStore.get(ctx, memoryB.id))?.lastReinforcedAt ?? null).toBeNull();
    });
  }
});

describe("memory_usage の externalId は Observation 行の列で、payload には入らない", () => {
  it("保存された Observation の externalId 列に入り、payload は recallId と usedMemoryIds だけ", async () => {
    const { runtime, stores, memoryA, recallA } = await setup();

    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      externalId: "usage-column",
      recallId: recallA,
      usedMemoryIds: [memoryA.id],
    });

    const stored = await stores.memoryStore.getObservation(ctx, result.observationId);
    expect(stored?.externalId).toBe("usage-column");
    expect(stored?.payload).toEqual({ recallId: recallA, usedMemoryIds: [memoryA.id] });
  });
});

describe("memory_usage の externalId が別の kind の Observation と衝突したとき", () => {
  const others = [
    ["utterance", { text: "発話" }],
    ["event", { name: "出来事", data: {} }],
    ["document", { title: "題", content: "本文" }],
  ] as const;
  for (const [kind, payload] of others) {
    it(`${kind} と衝突したら、使用を記録せず、その Observation を skipped で返す`, async () => {
      const { runtime, stores, memoryA, recallA } = await setup();
      const other = await stores.memoryStore.createObservation(ctx, {
        tenantId: "tenant-1",
        subjectId: null,
        externalId: "usage-conflict",
        kind,
        payload,
        occurredAt: null,
        recordedAt: NOW,
      });

      const result = await runtime.observe(ctx, {
        kind: "memory_usage",
        externalId: "usage-conflict",
        recallId: recallA,
        usedMemoryIds: [memoryA.id],
      });

      expect(result).toEqual({
        observationId: other.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
      });
      expect((await stores.memoryStore.get(ctx, memoryA.id))?.lastReinforcedAt ?? null).toBeNull();
    });
  }
});

describe("memory_usage の externalId の形", () => {
  it("空文字は断り、何も書かない", async () => {
    const { runtime, stores, memoryA, recallA } = await setup();
    await expect(
      runtime.observe(ctx, {
        kind: "memory_usage",
        externalId: "",
        recallId: recallA,
        usedMemoryIds: [memoryA.id],
      }),
    ).rejects.toThrow();
    expect((await stores.memoryStore.get(ctx, memoryA.id))?.lastReinforcedAt ?? null).toBeNull();
  });

  it("1文字は受け、同じ1文字の再送は同じ Observation を返す", async () => {
    const { runtime, memoryA, recallA } = await setup();
    const input = {
      kind: "memory_usage" as const,
      externalId: "x",
      recallId: recallA,
      usedMemoryIds: [memoryA.id],
    };
    const first = await runtime.observe(ctx, input);
    const second = await runtime.observe(ctx, input);
    expect(second.observationId).toBe(first.observationId);
  });
});
