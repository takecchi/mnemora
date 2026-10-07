import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
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

function buildRuntime(memoryStoreOverride?: MemoryStore) {
  const stores = createFakeRuntimeStores();
  const memoryStore = memoryStoreOverride ?? stores.memoryStore;
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
  return { runtime, stores };
}

/** `deps.memoryStore.resolveOrphanedContested` が無い adapter を模す。 */
function disableResolveOrphanedContested(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "resolveOrphanedContested", {
    value: undefined,
    configurable: true,
  });
}

/**
 * `stores.memoryStore` を包み、`get(ctx, hiddenId)` だけ `null` を返すようにする。「対向が purge 済みで見つからない」を
 * 実際に行を消さずに模すための道具（`purgeMemory` は今日どの実装も物理削除しない（tombstone するだけ）ため、
 * これ以外に「見つからない」を作る経路が無い）。
 */
function hideMemory(store: MemoryStore, hiddenId: string): MemoryStore {
  const originalGet = store.get.bind(store);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return async (c: Ctx, id: string) => (id === hiddenId ? null : originalGet(c, id));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** `markContested` で a/b を対向の `contested` にしてから返す（各歯の共通セットアップ）。 */
async function createContestedPair(
  runtime: ReturnType<typeof buildRuntime>["runtime"],
  stores: ReturnType<typeof buildRuntime>["stores"],
) {
  const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
  const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
  const marked = await runtime.markContested(ctx, a.id, b.id);
  expect(marked.outcome.kind).toBe("contested");
  return { a, b };
}

/** 対を作り、b を forget する。 */
async function createOrphanedPair(
  runtime: ReturnType<typeof buildRuntime>["runtime"],
  stores: ReturnType<typeof buildRuntime>["stores"],
) {
  const { a, b } = await createContestedPair(runtime, stores);
  const forgetResult = await runtime.forget(ctx, { memoryId: b.id });
  expect(forgetResult.outcomes).toEqual([
    { memoryId: b.id, kind: "forgotten", previousStatus: "contested" },
  ]);
  return { a, b };
}

describe("runtime.resolveOrphanedContested — 再現の解消（Issue #825）", () => {
  it("① 前提: forget 直後は resolveContested を呼んでも ineligible のまま固まる（既存の挙動、不変）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "eligible" },
          { memoryId: b.id, kind: "status_not_contested", status: "forgotten" },
        ],
      },
    });
    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("contested");
  });

  it("② resolveOrphanedContested(a) は a を active に戻し、contestedWithId を null にする。b（forgotten）には触れない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result.supported).toBe(true);
    expect(result.outcome.kind).toBe("resolved");
    if (result.outcome.kind !== "resolved") throw new Error("unreachable");
    expect(result.outcome.memory.status).toBe("active");
    expect(result.outcome.memory.contestedWithId).toBeNull();

    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("active");
    expect(survivor?.contestedWithId).toBeNull();

    const forgotten = await stores.memoryStore.get(ctx, b.id);
    expect(forgotten?.status).toBe("forgotten");
    expect(forgotten?.contestedWithId).toBe(a.id);
  });

  it("③ イベント: 生存側にだけ updated が1件積まれ、meta.resolution は resolveContested の正規経路と区別できる値になる", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);
    const aEventsBefore = await stores.eventStore.list(ctx, { memoryId: a.id });
    const bEventsBefore = await stores.eventStore.list(ctx, { memoryId: b.id });

    await runtime.resolveOrphanedContested!(ctx, a.id, { reason: "手動で気づいた" });

    const aEventsAfter = await stores.eventStore.list(ctx, { memoryId: a.id });
    const newEvents = aEventsAfter.filter(
      (e) => !aEventsBefore.some((before) => before.id === e.id),
    );
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]?.kind).toBe("updated");
    expect(newEvents[0]?.meta).toMatchObject({
      reason: "contested_resolved",
      resolution: "orphan_reclaimed",
      note: "手動で気づいた",
    });

    const bEventsAfter = await stores.eventStore.list(ctx, { memoryId: b.id });
    expect(bEventsAfter).toHaveLength(bEventsBefore.length);
  });

  it("④ 対向が見つからない（purge 済み相当）場合も eligible として解決する", async () => {
    const { runtime: setupRuntime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(setupRuntime, stores);

    const hiddenStore = hideMemory(stores.memoryStore, b.id);
    const { runtime: runtimeWithHiddenB } = buildRuntime(hiddenStore);

    const result = await runtimeWithHiddenB.resolveOrphanedContested!(ctx, a.id);

    expect(result.outcome.kind).toBe("resolved");
    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("active");
    expect(survivor?.contestedWithId).toBeNull();
  });
});

describe("runtime.resolveOrphanedContested — ineligible（書き込みは一切試みない）", () => {
  it("not_found: 存在しない id を渡すと ineligible.not_found を返す", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.resolveOrphanedContested!(ctx, "does-not-exist");

    expect(result).toEqual({
      supported: true,
      outcome: { kind: "ineligible", eligibility: { kind: "not_found" } },
    });
  });

  it("status_not_contested: 生存側自身が forgotten だと解決を拒む（対向を戻す口ではない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);
    await runtime.forget(ctx, { memoryId: a.id });

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        eligibility: { kind: "status_not_contested", status: "forgotten" },
      },
    });
    void b;
  });

  it("no_contested_with_id: contestedWithId が null な contested（ADR 0150 負債2 の形）は対象外", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createContestedPair(runtime, stores);
    // 壊れたデータ（書き込み側では今日作れない状態）を、fake 内部の行を直接いじって模す。
    // `get` は写しを返す。store の中の行そのものを書き換えるので `liveRowForTest` を使う。
    const stored = stores.memoryStore.liveRowForTest(ctx, a.id);
    if (stored) stored.contestedWithId = null;

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result).toEqual({
      supported: true,
      outcome: { kind: "ineligible", eligibility: { kind: "no_contested_with_id" } },
    });
  });

  it("opposite_not_orphaned（active）: forget していない、まだ争っている対では対象外", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        eligibility: {
          kind: "opposite_not_orphaned",
          contestedWithId: b.id,
          oppositeStatus: "contested",
        },
      },
    });
    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("contested");
  });

  it("opposite_not_orphaned（superseded）: 対向が resolveContested(supersede) で決着済みの場合も対象外", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    // a を負けさせて superseded にし、a の contestedWithId だけを直接 b へ戻す。
    await runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: b.id });
    // `get` は写しを返す。store の中の行そのものを書き換えるので `liveRowForTest` を使う。
    const stored = stores.memoryStore.liveRowForTest(ctx, a.id);
    if (stored) {
      stored.status = "contested";
      stored.contestedWithId = b.id;
    }

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        eligibility: {
          kind: "opposite_not_orphaned",
          contestedWithId: b.id,
          oppositeStatus: "active",
        },
      },
    });
  });
});

describe("runtime.resolveOrphanedContested — 並行（MemoryStatusConflictError）", () => {
  it("読んだ後・書く前に生存側の status が変わっていた⟹ conflict を返し、1回だけ再読する", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createOrphanedPair(runtime, stores);
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === a.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        stores.memoryStore.liveRowForTest(ctx, a.id)!.status = "archived";
      }
    };

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result).toEqual({
      supported: true,
      outcome: { kind: "conflict", observedStatus: "archived" },
    });
  });
});

describe("runtime.resolveOrphanedContested — MemoryStore.resolveOrphanedContested が無い adapter", () => {
  it("supported: false / not_attempted を返し、フォールバックしない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createOrphanedPair(runtime, stores);
    disableResolveOrphanedContested(stores);

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result).toEqual({ supported: false, outcome: { kind: "not_attempted" } });
    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("contested");
  });
});

describe("runtime.resolveOrphanedContested — tick()/observe() から呼ばれない", () => {
  it("tick() を呼んでも orphaned な contested は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createOrphanedPair(runtime, stores);

    await runtime.tick(ctx, { leaseMs: 60_000 });

    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("contested");
  });
});

describe("runtime.resolveOrphanedContested — イベントの meta と並行の細部", () => {
  it("reason を渡さないとき、meta に note のキー自体が無い", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);
    const before = await stores.eventStore.list(ctx, { memoryId: a.id });

    await runtime.resolveOrphanedContested!(ctx, a.id);

    const after = await stores.eventStore.list(ctx, { memoryId: a.id });
    const added = after.filter((e) => !before.some((x) => x.id === e.id));
    expect(added).toHaveLength(1);
    const meta = added[0]!.meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["contestedWithId", "reason", "resolution"]);
    expect(meta.contestedWithId).toBe(b.id);
  });

  it("書き込みが conflict で失敗したとき、store の書き込みは1回しか呼ばれない（再試行しない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createOrphanedPair(runtime, stores);
    const original = stores.memoryStore.resolveOrphanedContested.bind(stores.memoryStore);
    let calls = 0;
    Object.defineProperty(stores.memoryStore, "resolveOrphanedContested", {
      value: (...args: Parameters<typeof original>) => {
        calls += 1;
        return original(...args);
      },
      configurable: true,
    });
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === a.id) {
        stores.memoryStore.liveRowForTest(ctx, a.id)!.status = "archived";
      }
    };

    const result = await runtime.resolveOrphanedContested!(ctx, a.id);

    expect(result.outcome).toEqual({ kind: "conflict", observedStatus: "archived" });
    expect(calls).toBe(1);
  });

  it("conflict のあと再読して生存側が見つからなければ observedStatus は null", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createOrphanedPair(runtime, stores);
    let hidden = false;
    const proxied = new Proxy(stores.memoryStore, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (c: Ctx, id: string) => (hidden && id === a.id ? null : target.get(c, id));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === a.id) {
        stores.memoryStore.liveRowForTest(ctx, a.id)!.status = "archived";
        hidden = true;
      }
    };
    const { runtime: runtimeOnProxy } = buildRuntime(proxied);

    const result = await runtimeOnProxy.resolveOrphanedContested!(ctx, a.id);

    expect(result.outcome).toEqual({ kind: "conflict", observedStatus: null });
    void runtime;
  });
});

describe("FakeMemoryStore.resolveOrphanedContested — 渡された event をそのまま積む", () => {
  it("kind・actor・digestSnapshot・meta は渡した値のまま返り、eventStore にもその値で入る", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);

    const { event } = await stores.memoryStore.resolveOrphanedContested(ctx, {
      id: a.id,
      contestedWithId: b.id,
      event: {
        tenantId: ctx.tenantId,
        memoryId: a.id,
        kind: "forgotten",
        actor: { type: "human", id: "u1" },
        digestSnapshot: "snap",
        meta: { custom: 1 },
      },
    });

    expect(event).toMatchObject({
      kind: "forgotten",
      actor: { type: "human", id: "u1" },
      digestSnapshot: "snap",
      meta: { custom: 1 },
    });
    const listed = await stores.eventStore.list(ctx, { memoryId: a.id });
    expect(listed.filter((e) => e.id === event.id)).toMatchObject([
      { kind: "forgotten", actor: { type: "human", id: "u1" }, meta: { custom: 1 } },
    ]);
  });
});
