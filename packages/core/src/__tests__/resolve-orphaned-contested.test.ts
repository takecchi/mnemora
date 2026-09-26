import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.resolveOrphanedContested`（[Issue #825](https://github.com/takecchi/mnemora/issues/825)、
 * ADR 0150 追記）の歯。`resolve-contested.test.ts`（決定3 の CAS を課す正規経路）を手本にした、
 * 救済経路の対称な検査。
 *
 * 出典の再現: `runtime.markContested(a, b)` で対を作り、`runtime.forget(b)` すると、
 * `a` は `status: "contested"`・`contestedWithId: b.id` のまま残り、`resolveContested(a, b, ...)`
 * は `b` が `status_not_contested (forgotten)` で ineligible になり、`a` を戻す手段が無くなる
 * （再現テストは枝 `fix/forget-contested-pair` commit `1a79680` の
 * `forget-contested-pair.test.ts`）。本ファイルはこの再現の続きとして、`resolveOrphanedContested`
 * が `a` を `active` へ戻せることを検査する。
 *
 * 設計の要点（`runtime.ts` の `ResolveOrphanedContestedOutcome`/`resolveOrphanedContested` の
 * doc コメント参照）:
 * - **`resolveContested`/`MemoryStore.resolveContestedPair`（決定3の CAS）には一切触れない**
 *   ——既存の呼び出しの振る舞いが変わっていないことも、この歯で確かめる。
 * - 対象は「生存側が `status === 'contested'` かつ、`contestedWithId` の指す先が
 *   `forgotten` か見つからない」場合に限る。それ以外（`not_found`/`status_not_contested`/
 *   `no_contested_with_id`/`opposite_not_orphaned`）は ineligible で、書き込みは一切しない。
 * - 書き換えるのは生存側1件の `status`（→`active`）と `contestedWithId`（→`null`）だけ。
 *   対向（forgotten）の行には一切触れない。
 * - CAS で書く。TOCTOU は `conflict` として返し、上限の無い再試行はしない。
 * - `MemoryStore.resolveOrphanedContested` が無い adapter では `supported: false` になり、
 *   フォールバックしない。
 * - `tick()`/`observe()` からは呼ばれない。
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
 * `stores.memoryStore` を包み、`get(ctx, hiddenId)` だけ `null` を返すようにする
 * （ADR 0150 の変異試験と同じ「`MemoryStore` を包んで作る」作法。本番コードは1バイトも
 * 触らない）。「対向が purge 済みで見つからない」を、実際に行を消さずに模すための道具
 * ——`purgeMemory` は今日どの実装も物理削除しない（tombstone するだけ）ため、これ以外の
 * 方法で「見つからない」を作る経路が無い。
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

/** Issue #825 の再現そのもの: 対を作り、b を forget する。 */
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

    const result = await runtime.resolveOrphanedContested(ctx, a.id);

    expect(result.supported).toBe(true);
    expect(result.outcome.kind).toBe("resolved");
    if (result.outcome.kind !== "resolved") throw new Error("unreachable");
    expect(result.outcome.memory.status).toBe("active");
    expect(result.outcome.memory.contestedWithId).toBeNull();

    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("active");
    expect(survivor?.contestedWithId).toBeNull();

    // 対向（forgotten）は一切書き換わっていない——status も contestedWithId も元のまま。
    const forgotten = await stores.memoryStore.get(ctx, b.id);
    expect(forgotten?.status).toBe("forgotten");
    expect(forgotten?.contestedWithId).toBe(a.id);
  });

  it("③ イベント: 生存側にだけ updated が1件積まれ、meta.resolution は resolveContested の正規経路と区別できる値になる", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);
    const aEventsBefore = await stores.eventStore.list(ctx, { memoryId: a.id });
    const bEventsBefore = await stores.eventStore.list(ctx, { memoryId: b.id });

    await runtime.resolveOrphanedContested(ctx, a.id, { reason: "手動で気づいた" });

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

    // b 側には新しいイベントが積まれていない——対向の行には一切触れない。
    const bEventsAfter = await stores.eventStore.list(ctx, { memoryId: b.id });
    expect(bEventsAfter).toHaveLength(bEventsBefore.length);
  });

  it("④ 対向が見つからない（purge 済み相当）場合も eligible として解決する", async () => {
    const { runtime: setupRuntime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(setupRuntime, stores);

    const hiddenStore = hideMemory(stores.memoryStore, b.id);
    const { runtime: runtimeWithHiddenB } = buildRuntime(hiddenStore);

    const result = await runtimeWithHiddenB.resolveOrphanedContested(ctx, a.id);

    expect(result.outcome.kind).toBe("resolved");
    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("active");
    expect(survivor?.contestedWithId).toBeNull();
  });
});

describe("runtime.resolveOrphanedContested — ineligible（書き込みは一切試みない）", () => {
  it("not_found: 存在しない id を渡すと ineligible.not_found を返す", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.resolveOrphanedContested(ctx, "does-not-exist");

    expect(result).toEqual({
      supported: true,
      outcome: { kind: "ineligible", eligibility: { kind: "not_found" } },
    });
  });

  it("status_not_contested: 生存側自身が forgotten だと解決を拒む（対向を戻す口ではない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createOrphanedPair(runtime, stores);
    await runtime.forget(ctx, { memoryId: a.id });

    const result = await runtime.resolveOrphanedContested(ctx, a.id);

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
    // ADR 0140 以前の壊れたデータ（書き込み側では今日作れない状態）を、fake 内部の行を
    // 直接いじって模す——`resolveContestedPair` の変異試験と同じ「テスト側だけで壊れた
    // 状態を作る」作法。
    const stored = await stores.memoryStore.get(ctx, a.id);
    if (stored) stored.contestedWithId = null;

    const result = await runtime.resolveOrphanedContested(ctx, a.id);

    expect(result).toEqual({
      supported: true,
      outcome: { kind: "ineligible", eligibility: { kind: "no_contested_with_id" } },
    });
  });

  it("opposite_not_orphaned（active）: forget していない、まだ争っている対では対象外", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);

    const result = await runtime.resolveOrphanedContested(ctx, a.id);

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
    // a を負けさせて superseded にし、a の contestedWithId だけを直接 b へ戻す
    // （「決着後の対向を、なお contestedWithId が指している」という壊れ方をテスト側で作る）。
    await runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: b.id });
    const stored = await stores.memoryStore.get(ctx, a.id);
    if (stored) {
      stored.status = "contested";
      stored.contestedWithId = b.id;
    }

    const result = await runtime.resolveOrphanedContested(ctx, a.id);

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
        a.status = "archived";
      }
    };

    const result = await runtime.resolveOrphanedContested(ctx, a.id);

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

    const result = await runtime.resolveOrphanedContested(ctx, a.id);

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
