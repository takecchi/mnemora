import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

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

function overLimitAssociationCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "over_limit" && x.stage === "association");
  return o?.kind === "over_limit" ? o.count : undefined;
}

function budgetDroppedCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "budget_dropped");
  return o?.kind === "budget_dropped" ? o.count : undefined;
}

describe("recall() — 段3.5 で席に着けなかった候補が同伴として返ったときの排他性（Issue #1020）", () => {
  async function setup() {
    const { runtime, stores } = buildRuntime();
    const x = await createEmbeddedMemory(stores, [0.8, 0.6, 0], { digest: "X" });
    const a = await createEmbeddedMemory(stores, [0.6, 0.8, 0], { digest: "AAAA" });
    const b = await createEmbeddedMemory(stores, [0.55, 0.835, 0], { digest: "BBBB" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
    return { runtime, stores, x, a, b };
  }

  it("(a) 席を競り負けた候補が同伴として返ると、over_limit(association) に数えない", async () => {
    const { runtime, x, a, b } = await setup();
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
    });
    const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
    expect(byId.has(x.id)).toBe(true);
    expect(byId.get(a.id)?.retrievedVia).toBe("association");
    expect(byId.get(b.id)?.retrievedVia).toBe("mandatory_companion");
    expect(overLimitAssociationCount(result)).toBeUndefined();
  });

  it("(b) 同伴として取られた後に予算で落ちると、budget_dropped にだけ数える", async () => {
    const { runtime, x } = await setup();
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
      budget: { maxMemoryChars: x.digest.length },
    });
    expect(result.memories.map((m) => m.memoryId)).toEqual([x.id]);
    expect(budgetDroppedCount(result)).toBe(2);
    expect(overLimitAssociationCount(result)).toBeUndefined();
  });

  it("(c) 同伴として取られていない、席を競り負けただけの候補は over_limit(association) に残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = await setup();
    await createEmbeddedMemory(stores, [0.5, 0.866, 0], { digest: "C" });
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
    });
    expect(overLimitAssociationCount(result)).toBe(1);
  });

  it("(d) 席を競り負けた候補が2件同時に同伴として返ったときは、2件ぶん差し引き、残りの1件と countKind（exact）はそのまま残る", async () => {
    const { runtime, stores } = buildRuntime();
    const x = await createEmbeddedMemory(stores, [0.8, 0.6, 0], { digest: "X" });
    const a1 = await createEmbeddedMemory(stores, [0.6, 0.8, 0], { digest: "A1" });
    const a2 = await createEmbeddedMemory(stores, [0.62, 0.78, 0.05], { digest: "A2" });
    const b1 = await createEmbeddedMemory(stores, [0.5, 0.86, 0], { digest: "B1" });
    const b2 = await createEmbeddedMemory(stores, [0.45, 0.87, 0.1], { digest: "B2" });
    expect((await runtime.markContested(ctx, a1.id, b1.id)).outcome.kind).toBe("contested");
    expect((await runtime.markContested(ctx, a2.id, b2.id)).outcome.kind).toBe("contested");
    await createEmbeddedMemory(stores, [0.4, 0.9, 0], { digest: "C" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 2 },
      overFetchFactor: 10,
    });

    const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
    expect(byId.has(x.id)).toBe(true);
    expect(byId.get(b1.id)?.retrievedVia).toBe("mandatory_companion");
    expect(byId.get(b2.id)?.retrievedVia).toBe("mandatory_companion");
    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "association",
      count: 1,
      countKind: "exact",
    });
  });
});
