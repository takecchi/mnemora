import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore, ReinforceOptions } from "../interfaces/memory-store.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * [ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md):
 * `MemoryStore.supportsAddOwnSubjectSeq?()`（store の宣言）による、強化の渡し方の分岐。
 *
 * - 宣言が無い store（`addOwnSubjectSeq` を読まない第三者 adapter）には、runtime は今までどおりの値
 *   （`T + S_ctx` をそのまま `nowSeq` に、フラグなし）を渡す——挙動が今より悪くならない。
 * - 宣言のある store にだけ、`T` と `addOwnSubjectSeq: true` を渡す。
 *
 * 数値は T=10・S_alice=7・S_bob=20。
 */

const TENANT = "tenant-1";
const tenantCtx: Ctx = { tenantId: TENANT };
const aliceCtx: Ctx = { tenantId: TENANT, subjectId: "alice" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const RECORDED_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(subjectId: string | null): NewMemory {
  return {
    tenantId: TENANT,
    subjectId,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: RECORDED_AT,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: RECORDED_AT,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
    }),
    embeddingStatus: "pending",
    halfLifeRecalls: 100,
    decayBaseSeq: 0,
    decayFloorSeq: 100,
  };
}

const recallBase = {
  tenantId: TENANT,
  query: { text: "fixture" },
  budget: null,
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
};

type Variant = "declared" | "undeclared-ignores-flag";

/** 宣言のある fake、または「宣言が無く、フラグも読まない」第三者 adapter 相当の fake を作る。 */
async function setup(variant: Variant) {
  const stores = createFakeRuntimeStores();
  const store = stores.memoryStore as MemoryStore & {
    supportsAddOwnSubjectSeq?: () => boolean;
  };
  const captured: (ReinforceOptions | undefined)[] = [];
  const strip = (opts?: ReinforceOptions): ReinforceOptions | undefined =>
    opts === undefined ? undefined : { nowSeq: opts.nowSeq };
  const reinforce = store.reinforce.bind(store);
  const reinforceMany = store.reinforceMany!.bind(store);
  const recordUsageAndReinforce = store.recordUsageAndReinforce!.bind(store);
  const wrap = variant === "undeclared-ignores-flag" ? strip : (o?: ReinforceOptions) => o;
  store.reinforce = async (ctx, id, at, opts) => {
    captured.push(opts);
    return reinforce(ctx, id, at, wrap(opts));
  };
  store.reinforceMany = async (ctx, ids, at, opts) => {
    captured.push(opts);
    return reinforceMany(ctx, ids, at, wrap(opts));
  };
  store.recordUsageAndReinforce = async (ctx, recallId, ids, at, opts) => {
    captured.push(opts);
    return recordUsageAndReinforce(ctx, recallId, ids, at, wrap(opts));
  };
  if (variant === "undeclared-ignores-flag") {
    store.supportsAddOwnSubjectSeq = undefined;
  }
  const runtime = createRuntime({
    memoryStore: store,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");
  for (let i = 0; i < 10; i += 1) {
    await store.createRecall(tenantCtx, {
      ...recallBase,
      subjectId: null,
      advanceActivityClock: true,
    });
  }
  for (const [subjectId, n] of [
    ["alice", 7],
    ["bob", 20],
  ] as const) {
    for (let i = 0; i < n; i += 1) {
      await store.createRecall(tenantCtx, {
        ...recallBase,
        subjectId,
        advanceActivityClock: { scope: "subject", subjectId },
      });
    }
  }
  captured.length = 0;
  return { runtime, stores, store, captured };
}

async function reportUsage(
  s: Awaited<ReturnType<typeof setup>>,
  ctx: Ctx,
  ids: string[],
): Promise<void> {
  const recallId = await s.store.createRecall(tenantCtx, { ...recallBase, subjectId: null });
  await s.runtime.observe(ctx, {
    kind: "memory_usage",
    recallId,
    usedMemoryIds: ids,
    externalId: `usage-${Math.random()}`,
  });
}

/** 呼び出しの入れ子（recordUsageAndReinforce → reinforceMany → reinforce）で同じ opts が重なるので、重複を畳む。 */
function distinct(all: (ReinforceOptions | undefined)[]): (ReinforceOptions | undefined)[] {
  const seen = new Map<string, ReinforceOptions | undefined>();
  for (const o of all) seen.set(JSON.stringify(o ?? null), o);
  return [...seen.values()];
}

function floorFrom(baseSeq: number): number {
  return defaultActivityDecayStrategy.floorAt({ baseSeq, strength: 1, halfLifeRecalls: 100 });
}

describe("強化の渡し方は、store の宣言（supportsAddOwnSubjectSeq）で分かれる（ADR 0394）", () => {
  it("宣言が無い store には、今までどおり T + S_ctx をフラグなしの nowSeq として渡す（ctx=alice → 17）", async () => {
    const s = await setup("undeclared-ignores-flag");
    const memory = await s.store.createMemory(tenantCtx, newMemory("alice"));
    await reportUsage(s, aliceCtx, [memory.id]);
    expect(distinct(s.captured)).toEqual([{ nowSeq: 17 }]);
    const after = await s.store.get(tenantCtx, memory.id);
    expect(after?.decayBaseSeq).toBe(17);
    expect(after?.decayFloorSeq).toBe(floorFrom(17));
  });

  it("宣言が無い store には、subjectId の無い ctx では T のみをフラグなしで渡す（今日の main と同じ）", async () => {
    const s = await setup("undeclared-ignores-flag");
    const memory = await s.store.createMemory(tenantCtx, newMemory("alice"));
    await reportUsage(s, tenantCtx, [memory.id]);
    expect(distinct(s.captured)).toEqual([{ nowSeq: 10 }]);
    expect((await s.store.get(tenantCtx, memory.id))?.decayBaseSeq).toBe(10);
  });

  it("宣言が無い store への restoreArchived も、T + S_ctx をフラグなしで渡す", async () => {
    const s = await setup("undeclared-ignores-flag");
    const memory = await s.store.createMemory(tenantCtx, {
      ...newMemory("alice"),
      status: "archived",
    });
    await s.runtime.restoreArchived(aliceCtx, { memoryId: memory.id });
    expect(distinct(s.captured)).toEqual([{ nowSeq: 17 }]);
  });

  it("宣言のある store には、T と addOwnSubjectSeq: true を渡し、記憶自身の subject の T + S になる", async () => {
    const s = await setup("declared");
    expect(s.store.supportsAddOwnSubjectSeq?.()).toBe(true);
    const bob = await s.store.createMemory(tenantCtx, newMemory("bob"));
    await reportUsage(s, aliceCtx, [bob.id]);
    expect(distinct(s.captured)).toEqual([{ nowSeq: 10, addOwnSubjectSeq: true }]);
    const after = await s.store.get(tenantCtx, bob.id);
    expect(after?.decayBaseSeq).toBe(30);
    expect(after?.decayFloorSeq).toBe(floorFrom(30));
  });

  it("宣言のある store でも、declaration が false を返せば宣言が無いのと同じに扱う", async () => {
    const s = await setup("declared");
    s.store.supportsAddOwnSubjectSeq = () => false;
    const memory = await s.store.createMemory(tenantCtx, newMemory("alice"));
    await reportUsage(s, aliceCtx, [memory.id]);
    expect(distinct(s.captured)).toEqual([{ nowSeq: 17 }]);
  });
});
