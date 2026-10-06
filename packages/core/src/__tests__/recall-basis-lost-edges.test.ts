import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { InferredProvenance } from "../provenance.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RecalledMemory.basisLost` の約束のうち、`recall-basis-lost.test.ts` が見ていない4つ。
 * - 根拠が複数あるとき、1つでも失われていれば立つ（全部が失われたときだけ、ではない）。
 * - 根拠が contested の記憶なら、本文が残っているので立たない（archived・superseded と同じ）。
 * - 根拠の取得（`getMany`）は、重複を除いた id で1回だけ。
 * - 根拠の取得は、予算で切り詰めたあとに返る記憶の分だけ。切り詰めで全部落ちたら、根拠は引かない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
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
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function inferredProvenance(basisMemoryIds: string[]): InferredProvenance {
  return {
    kind: "inferred",
    model: "test-model",
    promptVersion: "v1",
    basis: { memoryIds: basisMemoryIds, observationIds: [] },
    confidence: 0.9,
  };
}

/** `getMany` に渡された id の並びを、呼ばれた順にすべて記録する。 */
function recordingMemoryStore(store: MemoryStore): {
  wrapped: MemoryStore;
  getManyCalls: string[][];
} {
  const getManyCalls: string[][] = [];
  const wrapped: MemoryStore = new Proxy(store, {
    get(target, prop) {
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
      if (prop === "getMany" && typeof value === "function") {
        return async (...args: unknown[]) => {
          getManyCalls.push([...(args[1] as string[])]);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as MemoryStore;
  return { wrapped, getManyCalls };
}

function setup() {
  const stores = createFakeRuntimeStores();
  const { wrapped, getManyCalls } = recordingMemoryStore(stores.memoryStore);
  const runtime = createRuntime({
    memoryStore: wrapped,
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
  return { runtime, stores, getManyCalls };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("basisLost: 根拠が複数あるとき、1つでも失われていれば立つ", () => {
  it("生きている根拠と forgotten の根拠が混ざっていても立つ", async () => {
    const { runtime, stores } = setup();
    const alive = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "alive" }));
    const gone = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "gone" }));
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      provenance: inferredProvenance([alive.id, gone.id]),
    });
    await runtime.forget(ctx, { memoryId: gone.id });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });

    expect(result.memories.find((m) => m.memoryId === inferred.id)?.basisLost).toBe(true);
  });

  it("生きている根拠と存在しない根拠が混ざっていても立つ", async () => {
    const { runtime, stores } = setup();
    const alive = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "alive" }));
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      provenance: inferredProvenance([alive.id, "does-not-exist"]),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });

    expect(result.memories.find((m) => m.memoryId === inferred.id)?.basisLost).toBe(true);
  });
});

describe("basisLost: contested の根拠は失われていない", () => {
  it("根拠が contested でも、キー自体が無い", async () => {
    const { runtime, stores } = setup();
    const contestedBasis = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "contested-basis", status: "contested" }),
    );
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      provenance: inferredProvenance([contestedBasis.id]),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });

    const returned = result.memories.find((m) => m.memoryId === inferred.id);
    expect(returned).toBeDefined();
    expect("basisLost" in returned!).toBe(false);
  });
});

describe("basisLost: 根拠の取得（getMany）", () => {
  it("同じ根拠を共有する複数の inferred でも、重複を除いた id で1回だけ引く", async () => {
    const { runtime, stores, getManyCalls } = setup();
    const basisA = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "basis-a" }));
    const basisB = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "basis-b" }));
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "inferred-1",
      provenance: inferredProvenance([basisA.id, basisB.id]),
    });
    await createEmbeddedMemory(stores, [0.99, 0.01], {
      digest: "inferred-2",
      provenance: inferredProvenance([basisB.id, basisA.id, basisA.id]),
    });

    await runtime.recall(ctx, { vector: [1, 0], association: null });

    const basisCalls = getManyCalls.filter((ids) => ids.includes(basisA.id));
    expect(basisCalls).toHaveLength(1);
    expect([...basisCalls[0]!].sort()).toEqual([basisA.id, basisB.id].sort());
  });

  it("予算の切り詰めで inferred が全部落ちたら、根拠は引かない", async () => {
    const { runtime, stores, getManyCalls } = setup();
    const basis = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "basis" }));
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "inferred-dropped-by-budget",
      provenance: inferredProvenance([basis.id]),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: null,
      budget: { maxMemoryChars: 1 },
    });

    expect(result.memories).toHaveLength(0);
    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(true);
    expect(getManyCalls.some((ids) => ids.includes(basis.id))).toBe(false);
  });
});
