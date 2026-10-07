import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };
const QUERY = [1, 0, 0, 0];

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
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

function build() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
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
  const add = async (vector: number[], digest: string): Promise<Memory> => {
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ digest }));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
    return memory;
  };
  return { runtime, add };
}

describe("recall() — 連想枠の起点（アンカー）と札", () => {
  it("同伴取得で足された contested の対向は、連想の起点にならない", async () => {
    const { runtime, add } = build();
    const owner = await add([1, 0, 0, 0], "O");
    const companion = await add([0, 1, 0, 0], "C");
    const nearCompanionOnly = await add([0, 1, 0, 0], "X");
    expect((await runtime.markContested(ctx, owner.id, companion.id)).outcome.kind).toBe(
      "contested",
    );

    const result = await runtime.recall(ctx, { vector: QUERY });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([owner.id, companion.id].sort());
    expect(result.memories.map((m) => m.memoryId)).not.toContain(nearCompanionOnly.id);
  });

  it("複数のアンカーがあるとき、associationOf は候補を実際に引いたアンカーを指す", async () => {
    const { runtime, add } = build();
    const anchor1 = await add([0.8, 0.6, 0, 0], "A1");
    const anchor2 = await add([0.7, 0, Math.sqrt(0.51), 0], "A2");
    const near1 = await add([0, 1, 0, 0], "X1");
    const near2 = await add([0, 0, 1, 0], "X2");

    const result = await runtime.recall(ctx, { vector: QUERY });

    const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
    expect(byId.get(anchor1.id)?.retrievedVia).toBe("ann");
    expect(byId.get(anchor2.id)?.retrievedVia).toBe("ann");
    expect(byId.get(near1.id)?.associationOf).toBe(anchor1.id);
    expect(byId.get(near2.id)?.associationOf).toBe(anchor2.id);
  });

  it("usage.byTier.association は連想で返った digest の文字数だけで、同伴取得・クエリ直撃の分を含まない", async () => {
    const { runtime, add } = build();
    const owner = await add([0.8, 0, 0.6, 0], "OOOO");
    const companion = await add([0, 1, 0, 0], "CC");
    const associated = await add([0, 0, 1, 0], "XXX");
    expect((await runtime.markContested(ctx, owner.id, companion.id)).outcome.kind).toBe(
      "contested",
    );

    const result = await runtime.recall(ctx, { vector: QUERY });

    const via = Object.fromEntries(result.memories.map((m) => [m.memoryId, m.retrievedVia]));
    expect(via).toEqual({
      [owner.id]: "ann",
      [companion.id]: "mandatory_companion",
      [associated.id]: "association",
    });
    expect(result.usage.byTier.association).toBe(3);
    expect(result.usage.byTier.digest).toBe(9);
  });

  it("association: null を明示すると byTier に association の欄が現れない", async () => {
    const { runtime, add } = build();
    await add([1, 0, 0, 0], "O");

    const result = await runtime.recall(ctx, { vector: QUERY, association: null });

    expect("association" in result.usage.byTier).toBe(false);
  });
});
