import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallQuery } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);
const ANCHOR_VECTOR = [0.70710678, 0.70710678];
const ASSOCIATED_VECTOR = [0, 1];
const ASSOCIATION = { maxCount: 5, anchorCount: 1 } as const;

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
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

function buildRuntime() {
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
  return { runtime, stores };
}

async function embedded(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

const QUERY: RecallQuery = { vector: [1, 0], limit: 10, includeFullyDecayed: true };

describe("recall() — 後置の status の再検査は contested を落とさない（ADR 0432 AL-1）", () => {
  it("段1：contested の記憶は、recall の memories に入る", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await embedded(stores, [1, 0]);
    const b = await embedded(stores, [0.9, 0.1]);
    await runtime.markContested(ctx, a.id, b.id);
    expect((await stores.memoryStore.get(ctx, a.id))?.status).toBe("contested");

    const result = await runtime.recall(ctx, QUERY);

    const ids = result.memories.map((x) => x.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("連想枠：contested の記憶は、連想枠から返る", async () => {
    const { runtime, stores } = buildRuntime();
    await embedded(stores, ANCHOR_VECTOR, { decayFloorAt: FAR_FUTURE });
    const associated = await embedded(stores, ASSOCIATED_VECTOR, { decayFloorAt: FAR_FUTURE });
    const partner = await embedded(stores, [-1, 0], { decayFloorAt: FAR_FUTURE });
    await runtime.markContested(ctx, associated.id, partner.id);

    const result = await runtime.recall(ctx, { ...QUERY, association: ASSOCIATION });

    expect(result.memories.map((x) => x.memoryId)).toContain(associated.id);
  });
});
