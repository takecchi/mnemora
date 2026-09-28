import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallStageName } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 段3.5（連想枠）は `explain.stages` に記録されない（今の振る舞い。`RecallStageName` の TSDoc と
 * `docs/recall.md` §1・§2、Issue #865）。連想枠を走らせたかは `usage.byTier.association` の有無に、返した記憶は
 * `retrievedVia === "association"`（と `associationOf`）に、飛ばしたときは `omitted` の `stage: "association"` に出る。
 *
 * ⚠ 望ましい姿の主張ではない（`RecallStageName` に値を足すかは決まっていない）。足すときは、この歯ごと書き換えること。
 * 記録の組み立ては `recall-association.test.ts` と同じ（写した）。
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

function buildRuntime(
  overrideVectorStore?: (stores: ReturnType<typeof createFakeRuntimeStores>) => VectorStore,
) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: overrideVectorStore ? overrideVectorStore(stores) : stores.vectorStore,
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

/** `RecallStageName` の今の値（型と同じ集合であることは、下の `satisfies` が型で確かめる）。 */
const STAGE_NAMES = [
  "scope",
  "candidate_generation",
  "rescore",
  "contradiction_resolution",
  "budget_truncation",
  "index_band",
  "record",
] as const satisfies readonly RecallStageName[];

function stageNames(result: { explain: { stages: { stage: string }[] } }): string[] {
  return result.explain.stages.map((s) => s.stage);
}

describe("段3.5（連想枠）は explain.stages に記録されない（Issue #865、今の振る舞い）", () => {
  it("連想で候補を拾った run でも stages に連想の段は無く、代わりの印（byTier・retrievedVia・associationOf）に出る", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const assocEntry = result.memories.find((m) => m.memoryId === associated.id);
    expect(assocEntry?.retrievedVia).toBe("association");
    expect(assocEntry?.associationOf).toBe(anchor.id);
    expect(result.usage.byTier.association).toBeGreaterThan(0);

    const names = stageNames(result);
    expect(names.every((name) => (STAGE_NAMES as readonly string[]).includes(name))).toBe(true);
    expect(names.some((name) => name.includes("association"))).toBe(false);
  });

  it("stages の並びは、連想枠を走らせた run と明示的に off（association: null）にした run で同じ", async () => {
    const on = buildRuntime();
    await createEmbeddedMemory(on.stores, [0.70710678, 0.70710678], { digest: "アンカー本文" });
    await createEmbeddedMemory(on.stores, [0, 1], { digest: "連想本文" });
    const off = buildRuntime();
    await createEmbeddedMemory(off.stores, [0.70710678, 0.70710678], { digest: "アンカー本文" });
    await createEmbeddedMemory(off.stores, [0, 1], { digest: "連想本文" });

    const withAssociation = await on.runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });
    const withoutAssociation = await off.runtime.recall(ctx, { vector: [1, 0], association: null });

    expect(withAssociation.memories.some((m) => m.retrievedVia === "association")).toBe(true);
    expect("association" in withoutAssociation.usage.byTier).toBe(false);
    expect(stageNames(withAssociation)).toEqual(stageNames(withoutAssociation));
  });

  it('連想枠を飛ばした run（アンカーが0件）は、stages ではなく omitted の stage: "association" に出る', async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0, 1]);

    const result = await runtime.recall(ctx, { vector: [1, 0], association: { maxCount: 5 } });

    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "association",
      reason: "no_anchor",
    });
    expect(result.usage.byTier.association).toBe(0);
    expect(stageNames(result).some((name) => name.includes("association"))).toBe(false);
  });
});
