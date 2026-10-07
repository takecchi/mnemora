import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 1_000 * 60 * 60 * 24;
const ctx: Ctx = { tenantId: "tenant-1" };

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    req.schema.parse({ memories: [{ content: "抽出結果", provenanceKind: "stated" }] }) as T,
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function newMemory(overrides: Partial<NewMemory>): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
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
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

describe("recall() — omitted の有効期間の件数は集計の値をそのまま名乗る", () => {
  it("期限切れ3件・未発効2件・有効1件のとき、expired は3、not_yet_valid は2", async () => {
    const { runtime, stores } = buildRuntime();
    const add = async (overrides: Partial<NewMemory>) => {
      const m = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, m.id, [1, 0]);
    };
    for (let i = 0; i < 3; i += 1)
      await add({ validUntil: new Date(NOW.getTime() - (i + 1) * DAY_MS) });
    for (let i = 0; i < 2; i += 1)
      await add({ validFrom: new Date(NOW.getTime() + (i + 1) * DAY_MS) });
    await add({});

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const counts = Object.fromEntries(
      result.omitted.filter((o) => o.kind === "filtered").map((o) => [o.condition, o.count]),
    );
    expect(counts["expired"]).toBe(3);
    expect(counts["not_yet_valid"]).toBe(2);
    expect(result.memories).toHaveLength(1);
  });
});

describe("recall() — 'wall' のテナントは活動カウンタを読まない", () => {
  it("既定のテナントで recall() しても getActivitySeq を呼ばない", async () => {
    const { runtime, stores } = buildRuntime();
    let calls = 0;
    const original = stores.tenantSettingsStore.getActivitySeq.bind(stores.tenantSettingsStore);
    stores.tenantSettingsStore.getActivitySeq = async (c: Ctx) => {
      calls += 1;
      return original(c);
    };
    const m = await stores.memoryStore.createMemory(ctx, newMemory({}));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, m.id, [1, 0]);

    await runtime.recall(ctx, { vector: [1, 0] });

    expect(calls).toBe(0);
  });
});

describe("runtime.observe — 'either' のテナントでも活動時計の3つ組が書かれる", () => {
  it("decay_clock が 'either' のとき、作られた記憶は decayBaseSeq・decayFloorSeq・halfLifeRecalls を持つ", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");

    const result = await runtime.observe(ctx, { kind: "utterance", text: "明日東京に出張します" });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);

    expect(memory?.decayBaseSeq).toBe(0);
    expect(memory?.halfLifeRecalls).not.toBeNull();
    expect(memory?.decayFloorSeq).toBeGreaterThan(0);
  });
});
