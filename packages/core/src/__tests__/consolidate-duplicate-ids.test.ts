import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(content: string): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
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
    embeddingStatus: "pending",
  };
}

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  let llmCalls = 0;
  const llm: LLMProvider = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      llmCalls += 1;
      return req.schema.parse({ content: "統合後" }) as T;
    },
  };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores, llmCalls: () => llmCalls };
}

describe("consolidate：材料は重複を除いて数える", () => {
  it("{ memoryIds: [a, a] } は eligible 1件として single_eligible_source になり、LLM を呼ばず何も書かない", async () => {
    const { runtime, stores, llmCalls } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, a.id] } });

    expect(result.outcome).toBe("nothing_to_consolidate");
    expect(result.nothingReason).toBe("single_eligible_source");
    expect(result.llmCalls).toBe(0);
    expect(llmCalls()).toBe(0);
    expect(result.consolidatedMemoryId).toBeNull();
    expect(result.sources.map((s) => s.memoryId)).toEqual([a.id, a.id]);
    expect((await stores.memoryStore.get(ctx, a.id))?.status).toBe("active");
  });

  it("{ memoryIds: [a, b, a] } は a と b の2件を統合し、統合先の sources に a は1回だけ載る", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id, a.id] } });

    expect(result.outcome).toBe("consolidated");
    const consolidated = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(consolidated?.provenance).toEqual({ kind: "consolidated", sources: [a.id, b.id] });
  });
});
