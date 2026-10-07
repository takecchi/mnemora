import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { FindCorrectionCandidatesResult } from "../correction-candidates.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** store が別の記憶を返す・候補が大文字小文字だけ違う2件・store が記憶を知らない、を作るため、core の Fake の `memoryStore.get` を差し替える。 */

const ctx: Ctx = { tenantId: "tenant-ac-spelling" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

type Stores = ReturnType<typeof createFakeRuntimeStores>;

function buildRuntime(getOverride?: (stores: Stores) => Stores["memoryStore"]["get"]) {
  const stores = createFakeRuntimeStores();
  const memoryStore = Object.create(stores.memoryStore) as Stores["memoryStore"];
  if (getOverride !== undefined) {
    Object.assign(memoryStore, { get: getOverride(stores) });
  }
  const runtime = createRuntime({
    memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    relationStore: stores.relationStore,
  });
  return { runtime, stores };
}

function discoveryOf(ids: string[]): FindCorrectionCandidatesResult {
  return {
    recallId: "recall-1" as FindCorrectionCandidatesResult["recallId"],
    candidates: ids.map((memoryId, i) => ({
      memoryId,
      digest: "d",
      recallRank: i + 1,
      score: {} as never,
      retrievedVia: "ann" as never,
    })),
    omitted: [],
    explain: { stages: [] },
    outcome: ids.length > 0 ? "candidates" : "no_candidates",
    recalledCount: ids.length,
    excludedCount: 0,
  };
}

async function snapshot(stores: Stores, ids: string[]) {
  return Promise.all(
    ids.map(async (id) => ({
      status: (await stores.memoryStore.get(ctx, id))?.status,
      events: (await stores.eventStore.list(ctx, { memoryId: id })).length,
    })),
  );
}

describe("applyCorrection: 勝者の検査は、候補だと決まってから（断る入力を増やさない）", () => {
  it("候補外の指名は、winnerId がどちらの id でもなくても例外にせず not_a_candidate を返し、何も書かない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));

    const result = await runtime.applyCorrection(ctx, {
      discovery: discoveryOf([c.id]),
      correctedId: a.id,
      correctingId: b.id,
      resolution: { kind: "supersede", winnerId: c.id },
    });

    expect(result).toEqual({ kind: "not_a_candidate", correctedId: a.id });
    expect(await snapshot(stores, [a.id, b.id, c.id])).toEqual([
      { status: "active", events: 0 },
      { status: "active", events: 0 },
      { status: "active", events: 0 },
    ]);
  });

  it("対照: 候補に居る指名で winnerId がどちらの id でもなければ、RangeError で、何も書かない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));

    await expect(
      runtime.applyCorrection(ctx, {
        discovery: discoveryOf([a.id]),
        correctedId: a.id,
        correctingId: b.id,
        resolution: { kind: "supersede", winnerId: c.id },
      }),
    ).rejects.toThrow(RangeError);
    expect(await snapshot(stores, [a.id, b.id, c.id])).toEqual([
      { status: "active", events: 0 },
      { status: "active", events: 0 },
      { status: "active", events: 0 },
    ]);
  });
});

describe("applyCorrection: correctedId と候補の id の綴りの照合", () => {
  it("対照: 大文字小文字だけ違う候補が1件で、store が同じ記憶と言えば、その候補として扱う", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    const result = await runtime.applyCorrection(ctx, {
      discovery: discoveryOf([a.id]),
      correctedId: a.id.toUpperCase(),
      correctingId: b.id,
    });

    expect(result.kind).toBe("contested");
  });

  it("store が、渡された綴りに別の記憶を返すなら、候補として扱わず、何も書かない", async () => {
    const holder: { other?: Memory } = {};
    const { runtime, stores } = buildRuntime((s) => async (c, id) => {
      if (holder.other !== undefined && id === id.toUpperCase() && id !== id.toLowerCase()) {
        return holder.other;
      }
      return s.memoryStore.get(c, id);
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    holder.other = b;

    const given = a.id.toUpperCase();
    const result = await runtime.applyCorrection(ctx, {
      discovery: discoveryOf([a.id]),
      correctedId: given,
      correctingId: b.id,
    });

    expect(result).toEqual({ kind: "not_a_candidate", correctedId: given });
    expect(await snapshot(stores, [a.id, b.id])).toEqual([
      { status: "active", events: 0 },
      { status: "active", events: 0 },
    ]);
  });

  it("store が、渡された綴りの記憶を知らない（null）なら、候補として扱わない", async () => {
    const { runtime, stores } = buildRuntime((s) => async (c, id) => {
      if (id !== id.toLowerCase()) return null;
      return s.memoryStore.get(c, id);
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    const given = a.id.toUpperCase();
    const result = await runtime.applyCorrection(ctx, {
      discovery: discoveryOf([a.id]),
      correctedId: given,
      correctingId: b.id,
    });

    expect(result).toEqual({ kind: "not_a_candidate", correctedId: given });
    expect(await snapshot(stores, [a.id, b.id])).toEqual([
      { status: "active", events: 0 },
      { status: "active", events: 0 },
    ]);
  });

  it("大文字小文字を無視して一致する候補が2件あるときは、どれと決められないので候補外（store が同じ記憶と言っても）", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    const lowerOnly = a.id.toLowerCase();
    const upperOnly = a.id.toUpperCase();
    const given = [...a.id].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch)).join("");
    expect([lowerOnly, upperOnly]).not.toContain(given);

    const result = await runtime.applyCorrection(ctx, {
      discovery: discoveryOf([lowerOnly, upperOnly]),
      correctedId: given,
      correctingId: b.id,
    });

    expect(result).toEqual({ kind: "not_a_candidate", correctedId: given });
    expect(await snapshot(stores, [a.id, b.id])).toEqual([
      { status: "active", events: 0 },
      { status: "active", events: 0 },
    ]);
  });
});
