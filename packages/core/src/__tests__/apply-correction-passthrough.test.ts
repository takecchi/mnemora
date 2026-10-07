import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
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
  return { runtime, stores };
}

/** `deps.memoryStore.markContestedPair` が無い adapter を模す（`mark-contested.test.ts` と同じ形）。 */
function disableMarkContestedPair(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "markContestedPair", {
    value: undefined,
    configurable: true,
  });
}

/**
 * `FakeEmbeddingProvider` は文字列長・'a' の数から決定的にベクトルを作る
 * （`correction-candidates.test.ts` と同じ約束事）。`"seed"` → `[4, 0]`。
 */
const QUERY_TEXT = "seed";

async function createCandidate(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
) {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

async function setup() {
  const { runtime, stores } = buildRuntime();
  const target = await createCandidate(stores, [8, 0], { digest: "対象" });
  const correcting = await createCandidate(stores, [1, 0], { digest: "訂正" });
  const discovery = await runtime.findCorrectionCandidates(ctx, {
    text: QUERY_TEXT,
    excludeMemoryIds: [correcting.id],
  });
  expect(discovery.candidates.map((c) => c.memoryId)).toContain(target.id);
  return { runtime, stores, target, correcting, discovery };
}

describe("runtime.applyCorrection — correctedId の「省略」は undefined だけである", () => {
  it("correctedId が空文字なら、渡されたが候補に居ないので not_a_candidate（awaiting_choice ではない）で、何も書かない", async () => {
    const { runtime, stores, correcting, discovery } = await setup();
    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: "" as typeof correcting.id,
      correctingId: correcting.id,
    });
    expect(result).toEqual({ kind: "not_a_candidate", correctedId: "" });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.applyCorrection — 綴り違いの候補の照合で、候補側を store が返さなくても落ちない", () => {
  it("渡された綴りの記憶は返るが、候補の綴りの記憶を store が返さない（null）なら、TypeError にせず not_a_candidate", async () => {
    const stores = createFakeRuntimeStores();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const given = a.id.toUpperCase();
    const memoryStore = Object.create(stores.memoryStore) as typeof stores.memoryStore;
    Object.assign(memoryStore, {
      get: async (c: Ctx, id: string) =>
        id === given ? b : id === a.id ? null : stores.memoryStore.get(c, id),
    });
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
    });
    const discovery = {
      recallId: "recall-1",
      candidates: [{ memoryId: a.id, digest: "d", recallRank: 1, score: {}, retrievedVia: "ann" }],
      omitted: [],
      explain: { stages: [] },
      outcome: "candidates",
      recalledCount: 1,
      excludedCount: 0,
    } as never;
    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: given as typeof a.id,
      correctingId: b.id,
    });
    expect(result).toEqual({ kind: "not_a_candidate", correctedId: given });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.applyCorrection — actor を markContested と resolveContested の両方へ渡す", () => {
  it("mark の2件も resolve の2件も、渡した actor で書かれる（system に落ちない）", async () => {
    const { runtime, stores, target, correcting, discovery } = await setup();
    const actor = { type: "human", id: "adopter-1" } as const;
    await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: correcting.id,
      resolution: { kind: "supersede", winnerId: correcting.id },
      actor,
    });
    const events = stores.eventStore.events;
    expect(events.filter((e) => e.meta.reason === "contested")).toHaveLength(2);
    expect(events.filter((e) => e.meta.reason === "contested_resolved")).toHaveLength(2);
    for (const e of events) expect(e.actor).toEqual(actor);
  });
});

describe("runtime.applyCorrection — correctedId を first、correctingId を second として運ぶ", () => {
  it("mark が ineligible のとき、sides は [訂正される側, 訂正する側] の順", async () => {
    const { runtime, target, discovery } = await setup();
    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: "does-not-exist" as typeof target.id,
    });
    if (result.kind !== "contested" || result.markResult.outcome.kind !== "ineligible") {
      throw new Error("unreachable");
    }
    expect(result.markResult.outcome.sides.map((s) => s.memoryId)).toEqual([
      target.id,
      "does-not-exist",
    ]);
  });

  it("resolve が ineligible のとき（mark を無効にした adapter）も、sides は [訂正される側, 訂正する側] の順", async () => {
    const { runtime, stores, target, correcting, discovery } = await setup();
    disableMarkContestedPair(stores);
    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: correcting.id,
      resolution: { kind: "both_active" },
    });
    if (result.kind !== "resolved" || result.resolveResult.outcome.kind !== "ineligible") {
      throw new Error("unreachable");
    }
    expect(result.resolveResult.outcome.sides.map((s) => s.memoryId)).toEqual([
      target.id,
      correcting.id,
    ]);
  });

  it("書き込まれるイベントの順は、mark（訂正される側, 訂正する側）→ resolve（同じ順）", async () => {
    const { runtime, stores, target, correcting, discovery } = await setup();
    await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: correcting.id,
      resolution: { kind: "both_active" },
    });
    expect(stores.eventStore.events.map((e) => [e.meta.reason, e.memoryId])).toEqual([
      ["contested", target.id],
      ["contested", correcting.id],
      ["contested_resolved", target.id],
      ["contested_resolved", correcting.id],
    ]);
  });
});

describe("runtime.applyCorrection — chosenRecallRank は候補の recallRank そのもの（並びの位置ではない）", () => {
  it("contested でも resolved でも、recallRank が 5 と 9 の候補から 9 の側を指名すれば 9", async () => {
    const { runtime, target, correcting, discovery } = await setup();
    const custom = {
      ...discovery,
      candidates: [
        { ...discovery.candidates[0]!, memoryId: correcting.id, recallRank: 5 },
        { ...discovery.candidates[0]!, memoryId: target.id, recallRank: 9 },
      ],
    };
    const onlyMark = await runtime.applyCorrection(ctx, {
      discovery: custom,
      correctedId: target.id,
      correctingId: correcting.id,
    });
    if (onlyMark.kind !== "contested") throw new Error("unreachable");
    expect(onlyMark.chosenRecallRank).toBe(9);
    const resolved = await runtime.applyCorrection(ctx, {
      discovery: custom,
      correctedId: target.id,
      correctingId: correcting.id,
      resolution: { kind: "both_active" },
    });
    if (resolved.kind !== "resolved") throw new Error("unreachable");
    expect(resolved.chosenRecallRank).toBe(9);
  });
});

describe("runtime.applyCorrection — 書き込みの口が投げた例外を握り潰さない", () => {
  it("resolveContestedPair が投げたら、そのまま reject する（resolved に倒さない）", async () => {
    const { runtime, stores, target, correcting, discovery } = await setup();
    Object.defineProperty(stores.memoryStore, "resolveContestedPair", {
      value: async () => {
        throw new Error("boom-resolve");
      },
      configurable: true,
    });
    await expect(
      runtime.applyCorrection(ctx, {
        discovery,
        correctedId: target.id,
        correctingId: correcting.id,
        resolution: { kind: "both_active" },
      }),
    ).rejects.toThrow("boom-resolve");
  });

  it("markContestedPair が投げたら、そのまま reject する（contested に倒さない）", async () => {
    const { runtime, stores, target, correcting, discovery } = await setup();
    Object.defineProperty(stores.memoryStore, "markContestedPair", {
      value: async () => {
        throw new Error("boom-mark");
      },
      configurable: true,
    });
    await expect(
      runtime.applyCorrection(ctx, {
        discovery,
        correctedId: target.id,
        correctingId: correcting.id,
      }),
    ).rejects.toThrow("boom-mark");
  });
});
