import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の #1467 のすり抜け W4（ADR 0381 の 2026-09-30 追記・約束7）。
 * `winnerId` が memberIds のどれかと大文字小文字だけ違うとき、store の `get` が両者（`winnerId` の綴りと、
 * memberIds の候補）に**同じ id の記憶を返したときだけ**救済する。両方 `null`（どちらも見つからない）は、
 * 「同じ記憶」の証拠にならないので `RangeError`。既存の歯は、片方だけ `null`・別の記憶を返す形しか見ていなかった。
 * 群版（`resolveContestedGroup`）と、2者版（`resolveContested`）は同じ形の判定を持つので、両方を縛る。
 */
const ctx: Ctx = { tenantId: "tenant-rescue-both-null" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(digest: string): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest,
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

/** `get` が常に `null` を返す store を配線した runtime（読み戻しは本物の store で行う）。 */
function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const calls: string[] = [];
  const memoryStore = Object.create(stores.memoryStore) as typeof stores.memoryStore;
  let getReturnsNull = false;
  memoryStore.get = (async (c: Ctx, id: string) => {
    calls.push(id);
    return getReturnsNull ? null : stores.memoryStore.get(c, id);
  }) as typeof stores.memoryStore.get;
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
  return {
    runtime,
    stores,
    calls,
    makeGetReturnNull: () => {
      getReturnsNull = true;
      calls.length = 0;
    },
  };
}

describe("winnerId の大文字小文字の救済は、get が両方 null のとき通さない（#1467 W4）", () => {
  it("群: resolveContestedGroup は RangeError。何も書かない", async () => {
    const { runtime, stores, calls, makeGetReturnNull } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
    const c = await stores.memoryStore.createMemory(ctx, newMemory("C"));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    makeGetReturnNull();

    await expect(
      runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
        kind: "supersede",
        winnerId: a.id.toUpperCase(),
      }),
    ).rejects.toThrow(RangeError);
    // 救済のために get を2回（winnerId の綴りと、候補）引いた上で、通していない。
    expect(calls).toEqual([a.id.toUpperCase(), a.id]);
    for (const id of [a.id, b.id, c.id]) {
      expect((await stores.memoryStore.get(ctx, id))?.status).toBe("contested");
    }
  });

  it("2者: resolveContested は RangeError。何も書かない", async () => {
    const { runtime, stores, calls, makeGetReturnNull } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
    const marked = await runtime.markContested(ctx, a.id, b.id);
    expect(marked.outcome.kind).toBe("contested");
    makeGetReturnNull();

    await expect(
      runtime.resolveContested(ctx, a.id, b.id, {
        kind: "supersede",
        winnerId: a.id.toUpperCase(),
      }),
    ).rejects.toThrow(RangeError);
    expect(calls).toEqual([a.id.toUpperCase(), a.id]);
    for (const id of [a.id, b.id]) {
      expect((await stores.memoryStore.get(ctx, id))?.status).toBe("contested");
    }
  });
});
