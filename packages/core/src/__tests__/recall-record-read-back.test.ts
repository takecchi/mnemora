import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createObservedMemory } from "./observed-memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-read-back", subjectId: "user-a" };

function newMemory(contentHash: string, overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: "user-a",
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash,
    digest: "digest",
    digestSource: "llm",
    provenance: {
      kind: "stated",
      speaker: "田中",
      sourceObservationId: "obs-1",
      at: NOW.toISOString(),
    } as never,
    tags: [],
    occurredAt: NOW,
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
    ...overrides,
  };
}

async function setup() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const first = await createObservedMemory(stores.memoryStore, ctx, newMemory("hash-1"));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, first.id, [1, 0]);
  const second = await createObservedMemory(stores.memoryStore, ctx, newMemory("hash-2"));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, second.id, [0.8, 0.6]);
  await createObservedMemory(
    stores.memoryStore,
    ctx,
    newMemory("hash-3", { embeddingStatus: "pending" }),
  );
  return { stores, runtime };
}

describe("Runtime.getRecall は、recall() が返した内容を recallId から読み戻せる", () => {
  it("返した記憶ごとの score・retrievedVia を、返した順のまま読み戻す", async () => {
    const { runtime } = await setup();
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(result.memories.length).toBeGreaterThanOrEqual(2);

    const record = await runtime.getRecall(ctx, result.recallId);

    expect(record?.returnedMemories).toEqual({
      breakdownCaptured: true,
      memories: result.memories.map((m) => ({
        memoryId: m.memoryId,
        score: m.score,
        retrievedVia: m.retrievedVia,
      })),
    });
  });

  it("返さなかった理由・使った量・目次帯・段の記録・予算・主題・時刻も、recall() の戻り値と同じ内容で読み戻す", async () => {
    const { runtime } = await setup();
    const budget = { maxMemoryChars: 1000 };
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, budget });
    expect(result.omitted.length).toBeGreaterThan(0);

    const record = await runtime.getRecall(ctx, result.recallId);

    expect(record).toMatchObject({
      recallId: result.recallId,
      tenantId: ctx.tenantId,
      subjectId: "user-a",
      budget,
      omitted: result.omitted,
      usage: result.usage,
      indexBand: result.index,
      explain: { stages: result.explain.stages },
      createdAt: NOW,
    });
    expect(record?.query).toMatchObject({ limit: 10 });
  });

  it("予算を渡さなかった recall の budget は null、主題を絞らなかった recall の subjectId も null", async () => {
    const { runtime } = await setup();
    const open: Ctx = { tenantId: ctx.tenantId };
    const result = await runtime.recall(open, { vector: [1, 0], limit: 10 });

    const record = await runtime.getRecall(open, result.recallId);

    expect(record?.budget).toBeNull();
    expect(record?.subjectId).toBeNull();
  });

  it("store の読み出しが失敗したときは、null にせず同じ例外を投げる", async () => {
    const { runtime, stores } = await setup();
    const failure = new Error("recalls table unavailable");
    stores.memoryStore.getRecall = async () => {
      throw failure;
    };

    await expect(runtime.getRecall(ctx, "any-id")).rejects.toBe(failure);
  });
});
