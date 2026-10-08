import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import {
  buildConsolidatedMemory,
  buildConsolidationPrompt,
  computeAffinity,
  intersectAttributes,
} from "../strategies/consolidate.js";
import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime, DEFAULT_CONSOLIDATE_MIN_AFFINITY } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。 */

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

/** `runtime.test.ts` の `llmReturning` と同じ形——統合結果を固定で返す決定的な偽物。 */
function llmConsolidatingTo(result: {
  content: string;
  digest?: string;
  tags?: string[];
}): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(result) as T,
  };
}

function throwingLlm(message = "simulated LLM outage"): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async () => {
      throw new Error(message);
    },
  };
}

/** `wireLexicalStore: true` で `stores.lexicalStore`（`FakeLexicalStore`）を配線する。窓（ANN/lexical 非対称）を測る歯だけが使う。 */
function buildRuntime(
  llmProvider: LLMProvider = notUsedLlm,
  opts: { wireLexicalStore?: boolean } = {},
) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: opts.wireLexicalStore === true ? stores.lexicalStore : undefined,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function supersededEvents(stores: ReturnType<typeof createFakeRuntimeStores>, memoryId: MemoryId) {
  return stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "superseded");
}

/** 公開された観測（イベントログ）だけで「新しい統合先が作られたか」を数える。`FakeMemoryStore` の private な `backing` へ直接アクセスしない。 */
function createdEventCount(stores: ReturnType<typeof createFakeRuntimeStores>): number {
  return stores.eventStore.events.filter((e) => e.kind === "created").length;
}

describe("runtime.consolidate — 基本の統合", () => {
  it("N件を統合すると Memory が1件増え、元N件が superseded になり supersededById が統合先を指す", async () => {
    const { runtime, stores } = buildRuntime(
      llmConsolidatingTo({ content: "統合後の本文", digest: "統合後の要旨" }),
    );
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ content: "C" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id, c.id] } });

    expect(result.outcome).toBe("consolidated");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure).toBeNull();
    expect(result.nothingReason).toBeNull();
    expect(result.consolidatedMemoryId).not.toBeNull();
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
      { memoryId: c.id, kind: "superseded", previousStatus: "active" },
    ]);

    for (const original of [a, b, c]) {
      const stored = await stores.memoryStore.get(ctx, original.id);
      expect(stored?.status).toBe("superseded");
      expect(stored?.supersededById).toBe(result.consolidatedMemoryId);
      expect(stored?.content).toBe(original.content);
    }

    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created?.content).toBe("統合後の本文");
    expect(created?.digest).toBe("統合後の要旨");
    expect(created?.status).toBe("active");

    const createdEvents = stores.eventStore.events.filter(
      (e) => e.memoryId === result.consolidatedMemoryId && e.kind === "created",
    );
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]!.meta).toEqual({ reason: "consolidated", sources: [a.id, b.id, c.id] });
  });

  it("統合先の provenance は { kind: 'consolidated', sources: [元の id...] }", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created?.provenance).toEqual({ kind: "consolidated", sources: [a.id, b.id] });
  });

  it("superseded イベントの meta.reason === 'consolidated'、digestSnapshot が入り content は入らない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "A本文", digest: "A要旨" }),
    );
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B本文" }));

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
      reason: "手動での統合テスト",
    });

    const events = supersededEvents(stores, a.id);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("superseded");
    expect(event.digestSnapshot).toBe("A要旨");
    expect(event.meta).toEqual({
      reason: "consolidated",
      supersededById: result.consolidatedMemoryId,
      note: "手動での統合テスト",
    });
    expect(Object.keys(event)).not.toContain("content");
    expect(JSON.stringify(event)).not.toContain("A本文");
  });

  it("opts.actor と opts.reason は、統合先の created イベントにも入る（統合元の superseded と同じ。reflect の created と同じ形）", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const actor = { type: "human" as const, id: "operator-1" };

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
      actor,
      reason: "手動での統合テスト",
    });

    const created = stores.eventStore.events.filter(
      (e) => e.memoryId === result.consolidatedMemoryId && e.kind === "created",
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.actor).toEqual(actor);
    expect(created[0]!.meta).toEqual({
      reason: "consolidated",
      sources: [a.id, b.id],
      note: "手動での統合テスト",
    });
    expect(supersededEvents(stores, a.id)[0]!.actor).toEqual(actor);
  });
});

describe("runtime.consolidate — 冪等性", () => {
  it("同じ id で2回呼ぶと、2回目は nothing_to_consolidate/no_eligible_sources・llmCalls:0・Memory が増えない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const first = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(first.outcome).toBe("consolidated");

    const createdCountAfterFirst = createdEventCount(stores);

    const second = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(second.outcome).toBe("nothing_to_consolidate");
    expect(second.nothingReason).toBe("no_eligible_sources");
    expect(second.llmCalls).toBe(0);
    expect(second.consolidatedMemoryId).toBeNull();
    expect(second.sources).toEqual([
      { memoryId: a.id, kind: "status_not_active", status: "superseded" },
      { memoryId: b.id, kind: "status_not_active", status: "superseded" },
    ]);
    expect(createdEventCount(stores)).toBe(createdCountAfterFirst);
  });

  it("eligible が1件だけなら single_eligible_source（0件の no_eligible_sources とは別の顔）", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, forgotten.id] },
    });

    expect(result.outcome).toBe("nothing_to_consolidate");
    expect(result.nothingReason).toBe("single_eligible_source");
    expect(result.llmCalls).toBe(0);
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "not_attempted" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
    ]);
  });
});

describe("runtime.consolidate — forgotten は統合元にならない", () => {
  it("forgotten な Memory は status_not_active に出て、superseded にならない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id, forgotten.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
    ]);

    const forgottenAfter = await stores.memoryStore.get(ctx, forgotten.id);
    expect(forgottenAfter?.status).toBe("forgotten");
    expect(forgottenAfter?.supersededById ?? null).toBeNull();
  });
});

describe("runtime.consolidate — not_found / status_not_active / not_attempted の別々の顔", () => {
  it("存在しない id・非 active・失敗による打ち切りが、それぞれ別の kind で出る", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const archived = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "ARC", status: "archived" }),
    );

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, "no-such-memory", archived.id, b.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: "no-such-memory", kind: "not_found" },
      { memoryId: archived.id, kind: "status_not_active", status: "archived" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
    ]);
  });
});

describe("runtime.consolidate — dryRun", () => {
  it("dryRun: LLM を呼ばず1件も書かず、eligible を返す", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );

    const eventCountBefore = stores.eventStore.events.length;

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id, forgotten.id] },
      dryRun: true,
    });

    expect(result.outcome).toBe("dry_run");
    expect(result.llmCalls).toBe(0);
    expect(result.consolidatedMemoryId).toBeNull();
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: b.id, kind: "eligible" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
    ]);
    expect(stores.eventStore.events.length).toBe(eventCountBefore);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
  });
});

describe("runtime.consolidate — LLM 障害", () => {
  it("LLM が投げたら llm_failed で、1件も superseded にならない", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm("provider is down"));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const createdCountBefore = createdEventCount(stores);

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("llm_failed");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure).toEqual({ kind: null, message: "provider is down" });
    expect(result.consolidatedMemoryId).toBeNull();
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "not_attempted" },
      { memoryId: b.id, kind: "not_attempted" },
    ]);
    expect(createdEventCount(stores)).toBe(createdCountBefore);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
  });
});

describe("runtime.consolidate — 並行の書き込み（CAS）", () => {
  /** `FakeMemoryStore` は `Memory` をその場で書き換え、`getMany` が同じ参照を配る。「読んでから書くまでの間に別の書き込みが割り込む」を決定的に測るため、`beforeUpdateStatus`（CAS 判定の直前に発火するテスト専用フック）で割り込ませる。 */
  it("CAS が破れたら status_changed_concurrently（他の1件は続行）", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    // `FakeMemoryStore.get` は写しを返すので、行そのものを引く `liveRowForTest` の参照の status を書き換えて「割り込み」を再現する。
    const aLive = stores.memoryStore.liveRowForTest(ctx, a.id);
    let intervened = false;
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (!intervened && id === a.id) {
        intervened = true;
        aLive!.status = "forgotten";
      }
    };

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "status_changed_concurrently", observedStatus: "forgotten" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
    ]);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("forgotten"); // consolidate は書き換えていない
    expect(aAfter?.supersededById ?? null).toBeNull();
  });
});

describe("runtime.consolidate — 途中で store が投げたら打ち切る", () => {
  it("2件目の superseded 更新が例外を投げたら、それ以降は not_attempted・例外は外へ出ない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ content: "C" }));

    // 口を持たない adapter の経路で測るため、口を外す。さもないと差し替えた `updateStatusWithEvent` が呼ばれず、歯が黙って意味を失う。
    // 口が在る経路の振る舞いは下の別の歯が測る。
    const base = stores.memoryStore;
    (base as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories = undefined;
    let updateCalls = 0;
    const failing = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "updateStatusWithEvent") {
          return async (...args: Parameters<MemoryStore["updateStatusWithEvent"]>) => {
            updateCalls += 1;
            if (updateCalls === 2) {
              throw new Error("simulated connection reset");
            }
            return target.updateStatusWithEvent(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryStore;

    const runtimeFailing = createRuntime({
      memoryStore: failing,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmConsolidatingTo({ content: "統合後" }),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    void runtime;

    const result = await runtimeFailing.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id, c.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "failed", error: "simulated connection reset" },
      { memoryId: c.id, kind: "not_attempted" },
    ]);

    const cAfter = await stores.memoryStore.get(ctx, c.id);
    expect(cAfter?.status).toBe("active"); // 3件目には一切触れていない
  });
});

describe("runtime.consolidate — recall() との裏取り（recall 側は変更していない）", () => {
  it("consolidate 後の recall() に元 Memory が出ず、omitted に filtered/superseded が出る", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "A", embeddingStatus: "ready" }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "B", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, b.id, [1, 0]);

    const beforeConsolidate = await runtime.recall(ctx, { vector: [1, 0] });
    expect(beforeConsolidate.memories.map((m) => m.memoryId)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );

    await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    const afterConsolidate = await runtime.recall(ctx, { vector: [1, 0] });
    expect(afterConsolidate.memories.map((m) => m.memoryId)).not.toContain(a.id);
    expect(afterConsolidate.memories.map((m) => m.memoryId)).not.toContain(b.id);
    expect(afterConsolidate.omitted).toContainEqual({
      kind: "filtered",
      condition: "superseded",
      scopeRelation: "outside_scope",
      count: 2,
      countKind: "exact",
    });
  });
});

/** 今の実装がこの窓（統合元は引けなくなったが、統合先は embed 前でまだ引けない）をどう見せるかを固定するだけで、塞ぐ変更ではない。 */
describe("runtime.consolidate — 統合直後の埋め込み非同期窓（ADR 0089 引き受けた負債4、Issue #765）", () => {
  function buildRuntimeWithRealClock(llmProvider: LLMProvider) {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    return { runtime, stores };
  }

  it("統合先は作られた直後 embeddingStatus: 'pending' で ANN では引けず、tick(embed) の後に初めて引ける", async () => {
    const { runtime, stores } = buildRuntimeWithRealClock(
      llmConsolidatingTo({ content: "統合後の本文" }),
    );
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "A", embeddingStatus: "ready" }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "B", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, b.id, [1, 0]);

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const consolidatedId = result.consolidatedMemoryId!;

    const justCreated = await stores.memoryStore.get(ctx, consolidatedId);
    expect(justCreated?.embeddingStatus).toBe("pending");

    const duringWindow = await runtime.recall(ctx, { text: "統合後の本文" });
    expect(duringWindow.memories.map((m) => m.memoryId)).not.toContain(consolidatedId);
    expect(duringWindow.memories.map((m) => m.memoryId)).not.toContain(a.id);
    expect(duringWindow.memories.map((m) => m.memoryId)).not.toContain(b.id);

    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const afterTick = await stores.memoryStore.get(ctx, consolidatedId);
    expect(afterTick?.embeddingStatus).toBe("ready");

    const afterEmbed = await runtime.recall(ctx, { text: "統合後の本文" });
    expect(afterEmbed.memories.map((m) => m.memoryId)).toContain(consolidatedId);
  });

  it("(c) lexical チャンネルを配線していれば、embeddingStatus: 'pending' のままでも統合先を引ける——ANN とは非対称", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後トークンXYZ" }), {
      wireLexicalStore: true,
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const consolidatedId = result.consolidatedMemoryId!;
    expect((await stores.memoryStore.get(ctx, consolidatedId))?.embeddingStatus).toBe("pending");

    const annOnly = await runtime.recall(ctx, { text: "XYZ", channels: ["ann"] });
    expect(annOnly.memories.map((m) => m.memoryId)).not.toContain(consolidatedId);

    // 語彙チャンネルは `memories.content` を直接引く経路であり、embeddingStatus には
    // 依存しない（`packages/postgres/src/lexical-store.ts` の SELECT に
    // embedding_status の絞りが無い。`FakeLexicalStore` も同じ契約）——
    // ⟹ tick 前でも統合先が引ける。
    const withLexical = await runtime.recall(ctx, { text: "XYZ", channels: ["lexical"] });
    expect(withLexical.memories.map((m) => m.memoryId)).toContain(consolidatedId);
  });
});

describe("runtime.consolidate — target の { query } の形", () => {
  it("{ query, maxCandidates } は recall() を1回呼び、返った順に先頭から切る", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "A", embeddingStatus: "ready" }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "B", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, b.id, [1, 0]);

    const result = await runtime.consolidate(ctx, {
      target: { query: { vector: [1, 0] }, maxCandidates: 1 },
    });

    expect(result.outcome).toBe("nothing_to_consolidate");
    expect(result.nothingReason).toBe("single_eligible_source");
    expect(result.sources).toHaveLength(1);
  });

  it("query が0件なら not_examined・store の Memory には一切触れない", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    void stores;

    const result = await runtime.consolidate(ctx, {
      target: { query: { vector: [9, 9] } },
    });

    expect(result).toEqual({
      outcome: "not_examined",
      nothingReason: null,
      consolidatedMemoryId: null,
      sources: [],
      llmCalls: 0,
      llmFailure: null,
      atomicity: "not_attempted",
    });
  });
});

describe("runtime.consolidate — target の { seedMemoryId } の形（Issue #135）", () => {
  it("既定の minAffinity（0.8）以上の近傍だけが種と一緒に統合される", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    // FakeEmbeddingProvider は文字列長・'a' の数からベクトルを作る（決定的）。
    // "seed" → [4, 0]。recall({ text: seed.digest }) はこのベクトルで ANN する。
    const seed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "seed content", digest: "seed", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);
    // [8, 0] は [4, 0] と同じ向き ⟹ cosine similarity = 1.0（≥ 0.8）。
    const high = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "high affinity neighbor", digest: "hn", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, high.id, [8, 0]);
    // [4, 4] は [4, 0] と45度 ⟹ cosine similarity ≈ 0.707（< 0.8）。
    const low = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "low affinity neighbor", digest: "ln", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, low.id, [4, 4]);

    const result = await runtime.consolidate(ctx, { target: { seedMemoryId: seed.id } });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.memoryId)).toEqual([seed.id, high.id]);
    expect(result.sources.every((s) => s.kind === "superseded")).toBe(true);
    const lowStored = await stores.memoryStore.get(ctx, low.id);
    expect(lowStored?.status).toBe("active");
  });

  it("minAffinity を渡すと既定を上書きできる", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const seed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "seed content", digest: "seed", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);
    const high = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "high affinity neighbor", digest: "hn", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, high.id, [8, 0]);
    // 前のテストと同じ ≈0.707 の近傍——既定 (0.8) なら落ちるが、minAffinity: 0.5 なら通る。
    const mid = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "mid affinity neighbor", digest: "mn", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, mid.id, [4, 4]);

    const result = await runtime.consolidate(ctx, {
      target: { seedMemoryId: seed.id, minAffinity: 0.5 },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.memoryId)).toEqual([seed.id, high.id, mid.id]);
  });

  it("種の embedding がまだ無く recall() の結果に現れなくても、種は先頭に足される", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const seed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "seed content", digest: "seed" }),
    );
    const neighbor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "neighbor", digest: "n", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, neighbor.id, [4, 0]);

    const result = await runtime.consolidate(ctx, { target: { seedMemoryId: seed.id } });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.memoryId)).toEqual([seed.id, neighbor.id]);
  });

  it("maxCandidates は種を残したまま [種, ...近傍] を先頭から切る", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const seed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "seed content", digest: "seed", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);
    const first = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "first neighbor", digest: "f1", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, first.id, [8, 0]);
    const second = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "second neighbor", digest: "f2", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, second.id, [8, 2]);

    const result = await runtime.consolidate(ctx, {
      target: { seedMemoryId: seed.id, maxCandidates: 2 },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.memoryId)).toEqual([seed.id, first.id]);
    const secondStored = await stores.memoryStore.get(ctx, second.id);
    expect(secondStored?.status).toBe("active");
  });

  it("種が見つからなければ recall を呼ばず、not_found・LLM を呼ばない", async () => {
    const { runtime } = buildRuntime(notUsedLlm);

    const result = await runtime.consolidate(ctx, {
      target: { seedMemoryId: "does-not-exist" },
    });

    expect(result).toEqual({
      outcome: "nothing_to_consolidate",
      nothingReason: "no_eligible_sources",
      consolidatedMemoryId: null,
      sources: [{ memoryId: "does-not-exist", kind: "not_found" }],
      llmCalls: 0,
      llmFailure: null,
      atomicity: "not_attempted",
    });
  });
});

describe("runtime.tick — consolidate ジョブは種の subjectId に近傍探索を絞る（Issue #579 / ADR 0317）", () => {
  function buildRuntimeWithRealClock(llmProvider: LLMProvider) {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    return { runtime, stores };
  }

  /** `FakeEmbeddingProvider` は使わず `vectorStore.upsert` で直接ベクトルを置き、同じベクトルを複数 subject の Memory に置いて「同一の話題を複数 subject が持つ」を模す。 */
  async function enqueueConsolidateJob(
    stores: ReturnType<typeof createFakeRuntimeStores>,
    overrides: Partial<NewMemory>,
  ): Promise<Memory> {
    const { memory, jobs } = await stores.memoryStore.createMemoryWithOutbox(
      ctx,
      newMemory(overrides),
      ["consolidate"],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ memoryId: memory.id });
    return memory;
  }

  it("ctx.subjectId 無しで tick を呼んでも、種の subject 以外の高affinity近傍は混ざらない（混在 0%）", async () => {
    const { runtime, stores } = buildRuntimeWithRealClock(
      llmConsolidatingTo({ content: "統合後" }),
    );

    const seed = await enqueueConsolidateJob(stores, {
      content: "seed content",
      digest: "seed",
      subjectId: "subject-a",
      embeddingStatus: "ready",
    });
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);

    const neighborSameSubject = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "same-subject neighbor",
        digest: "n-same",
        subjectId: "subject-a",
        embeddingStatus: "ready",
      }),
    );
    await stores.vectorStore.upsert(
      ctx,
      stores.embeddingProvider.space,
      neighborSameSubject.id,
      [8, 0],
    );

    // 別 subject の近傍も同じベクトルで、種の subject に絞らなければ既定の minAffinity（0.8）を満たして候補に入る。
    const neighborOtherSubject = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "other-subject neighbor",
        digest: "n-other",
        subjectId: "subject-b",
        embeddingStatus: "ready",
      }),
    );
    await stores.vectorStore.upsert(
      ctx,
      stores.embeddingProvider.space,
      neighborOtherSubject.id,
      [8, 0],
    );

    // `ctx` に subjectId を付けずに tick を呼ぶ（ADR 0310 の「絞らない」列）。
    const tickResult = await runtime.tick(ctx, { kinds: ["consolidate"], leaseMs: 60_000 });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const seedAfter = await stores.memoryStore.get(ctx, seed.id);
    expect(seedAfter?.status).toBe("superseded");
    const consolidated = await stores.memoryStore.get(ctx, seedAfter!.supersededById!);
    expect(consolidated).not.toBeNull();
    expect(consolidated!.subjectId).toBe("subject-a");
    expect(consolidated!.provenance).toMatchObject({
      kind: "consolidated",
      sources: expect.arrayContaining([seed.id, neighborSameSubject.id]),
    });
    expect((consolidated!.provenance as { sources: MemoryId[] }).sources).not.toContain(
      neighborOtherSubject.id,
    );
    const otherAfter = await stores.memoryStore.get(ctx, neighborOtherSubject.id);
    expect(otherAfter?.status).toBe("active");
  });

  it("tick に渡した ctx.subjectId が種と別でも、種の subject を優先する（種と同じ subject に絞る）", async () => {
    const { runtime, stores } = buildRuntimeWithRealClock(
      llmConsolidatingTo({ content: "統合後" }),
    );

    const seed = await enqueueConsolidateJob(stores, {
      content: "seed content",
      digest: "seed",
      subjectId: "subject-a",
      embeddingStatus: "ready",
    });
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);

    const neighborSameAsSeed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "same-as-seed neighbor",
        digest: "n-seed",
        subjectId: "subject-a",
        embeddingStatus: "ready",
      }),
    );
    await stores.vectorStore.upsert(
      ctx,
      stores.embeddingProvider.space,
      neighborSameAsSeed.id,
      [8, 0],
    );

    // `tick()` はジョブを subject で絞って claim できないので、ctx.subjectId の subject を優先すると種と別の subject が混ざる。それを防ぐ歯。
    const neighborSameAsCtx = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "same-as-ctx neighbor",
        digest: "n-ctx",
        subjectId: "subject-c",
        embeddingStatus: "ready",
      }),
    );
    await stores.vectorStore.upsert(
      ctx,
      stores.embeddingProvider.space,
      neighborSameAsCtx.id,
      [8, 0],
    );

    const ctxWithDifferentSubject: Ctx = { tenantId: "tenant-1", subjectId: "subject-c" };
    const tickResult = await runtime.tick(ctxWithDifferentSubject, {
      kinds: ["consolidate"],
      leaseMs: 60_000,
    });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const seedAfter = await stores.memoryStore.get(ctx, seed.id);
    expect(seedAfter?.status).toBe("superseded");
    const consolidated = await stores.memoryStore.get(ctx, seedAfter!.supersededById!);
    expect(consolidated).not.toBeNull();
    expect(consolidated!.subjectId).toBe("subject-a");
    expect((consolidated!.provenance as { sources: MemoryId[] }).sources).toEqual(
      expect.arrayContaining([seed.id, neighborSameAsSeed.id]),
    );
    expect((consolidated!.provenance as { sources: MemoryId[] }).sources).not.toContain(
      neighborSameAsCtx.id,
    );
    const ctxNeighborAfter = await stores.memoryStore.get(ctx, neighborSameAsCtx.id);
    expect(ctxNeighborAfter?.status).toBe("active");
  });

  it("種の subjectId が null なら、今日どおり ctx のまま呼ぶ（挙動を変えない）", async () => {
    const { runtime, stores } = buildRuntimeWithRealClock(
      llmConsolidatingTo({ content: "統合後" }),
    );

    const seed = await enqueueConsolidateJob(stores, {
      content: "seed content",
      digest: "seed",
      subjectId: null,
      embeddingStatus: "ready",
    });
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);

    const neighbor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "neighbor",
        digest: "n",
        subjectId: "subject-a",
        embeddingStatus: "ready",
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, neighbor.id, [8, 0]);

    const tickResult = await runtime.tick(ctx, { kinds: ["consolidate"], leaseMs: 60_000 });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const seedAfter = await stores.memoryStore.get(ctx, seed.id);
    expect(seedAfter?.status).toBe("superseded");
    const consolidated = await stores.memoryStore.get(ctx, seedAfter!.supersededById!);
    expect(consolidated).not.toBeNull();
    expect((consolidated!.provenance as { sources: MemoryId[] }).sources).toEqual(
      expect.arrayContaining([seed.id, neighbor.id]),
    );
  });

  /** 陽性対照: eligible が2件（種＋同一 subject の高 affinity 近傍）になるようにして、LLM 呼び出しの直前まで到達させる（近傍が無いと LLM を呼ばず nothing_to_consolidate で終わる）。 */
  describe("LLM が実際に失敗すると、tick は failed に数える（Issue #849 / ADR 0157 決定2 追記）", () => {
    function throwingLlmWithCallCount(message = "simulated LLM outage") {
      const state = { calls: 0 };
      const provider: LLMProvider = {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          state.calls += 1;
          throw new Error(message);
        },
      };
      return { provider, state };
    }

    it("LLM が例外を投げると、tick は processed:0/failed:1 を返し、outbox 行は終端の失敗のまま残り、種は active のまま", async () => {
      const { provider, state } = throwingLlmWithCallCount("simulated LLM outage");
      const { runtime, stores } = buildRuntimeWithRealClock(provider);

      const seed = await enqueueConsolidateJob(stores, {
        content: "seed content",
        digest: "seed",
        subjectId: "subject-a",
        embeddingStatus: "ready",
      });
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);

      const neighbor = await stores.memoryStore.createMemory(
        ctx,
        newMemory({
          content: "same-subject neighbor",
          digest: "n-same",
          subjectId: "subject-a",
          embeddingStatus: "ready",
        }),
      );
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, neighbor.id, [8, 0]);

      const tickResult = await runtime.tick(ctx, { kinds: ["consolidate"], leaseMs: 60_000 });

      expect(tickResult).toEqual({ processed: 0, failed: 1, unsupported: [], leaseConflicts: [] });
      // LLM が実際に呼ばれたこと自体を固定する: nothing_to_consolidate に化けて LLM を呼ばないまま緑になる退行を防ぐ。
      expect(state.calls).toBe(1);

      const seedAfter = await stores.memoryStore.get(ctx, seed.id);
      expect(seedAfter?.status).toBe("active");

      const row = stores.outboxStore.listJobs(ctx).find((job) => job.payload.memoryId === seed.id)!;
      expect(row.failedAt).not.toBeNull();
      expect(row.completedAt).toBeNull();
      expect(row.lastError).toContain("simulated LLM outage");
    });
  });
});

describe("computeAffinity（純関数、strategies/consolidate.ts）", () => {
  it("similarity と lexicalMatch の大きい方を返す", () => {
    expect(
      computeAffinity({
        similarity: 0.3,
        lexicalMatch: 0.7,
        decay: 1,
        tagMatch: 1,
        freshness: 1,
        strength: 1,
        total: 1,
      }),
    ).toBe(0.7);
    expect(
      computeAffinity({
        similarity: 0.9,
        lexicalMatch: 0.2,
        decay: 1,
        tagMatch: 1,
        freshness: 1,
        strength: 1,
        total: 1,
      }),
    ).toBe(0.9);
  });

  it("similarity だけのとき similarity をそのまま返す", () => {
    expect(
      computeAffinity({
        similarity: 0.42,
        decay: 1,
        tagMatch: 1,
        freshness: 1,
        strength: 1,
        total: 1,
      }),
    ).toBe(0.42);
  });

  it("lexicalMatch だけのとき lexicalMatch をそのまま返す", () => {
    expect(
      computeAffinity({
        lexicalMatch: 0.55,
        decay: 1,
        tagMatch: 1,
        freshness: 1,
        strength: 1,
        total: 1,
      }),
    ).toBe(0.55);
  });

  it("両方無い（mandatory_companion 経由など）なら -Infinity——どんな有限の minAffinity でも必ず落ちる", () => {
    const affinity = computeAffinity({
      decay: 1,
      tagMatch: 1,
      freshness: 1,
      strength: 1,
      total: 1,
    });
    expect(affinity).toBe(-Infinity);
    expect(affinity >= DEFAULT_CONSOLIDATE_MIN_AFFINITY).toBe(false);
  });

  it("affinityMeasured: false（AffinityUnmeasuredScore の形）も -Infinity——どんな有限の minAffinity でも必ず落ちる", () => {
    const affinity = computeAffinity({
      affinityMeasured: false,
      decay: 1,
      tagMatch: 1,
      freshness: 1,
      strength: 1,
    });
    expect(affinity).toBe(-Infinity);
    expect(affinity >= DEFAULT_CONSOLIDATE_MIN_AFFINITY).toBe(false);
    expect(affinity >= -1e9).toBe(false);
  });
});

describe("runtime.consolidate — 空の target", () => {
  it("空の { memoryIds: [] } は store に一切触れず not_examined を返す", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [] } });

    expect(result).toEqual({
      outcome: "not_examined",
      nothingReason: null,
      consolidatedMemoryId: null,
      sources: [],
      llmCalls: 0,
      llmFailure: null,
      atomicity: "not_attempted",
    });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("buildConsolidatedMemory（純関数）", () => {
  function fixtureMemory(overrides: Partial<Memory> = {}): Memory {
    const recordedAt = overrides.recordedAt ?? NOW;
    const strength = overrides.strength ?? 1;
    const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
    return {
      id: overrides.id ?? `mem-${Math.random()}`,
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      status: "active" as MemoryStatus,
      supersededById: null,
      contestedWithId: null,
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
      createdAt: recordedAt,
      updatedAt: recordedAt,
      ...overrides,
    };
  }

  it("subjectId が eligible 全件で一致すればその値、割れていれば null", () => {
    const same = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", subjectId: "subject-x" }),
        fixtureMemory({ id: "m2", subjectId: "subject-x" }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(same.subjectId).toBe("subject-x");

    const split = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", subjectId: "subject-x" }),
        fixtureMemory({ id: "m2", subjectId: "subject-y" }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(split.subjectId).toBeNull();
  });

  it("occurredAt は eligible のうち最も新しいもの。全部 null なら null", () => {
    const withDates = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", occurredAt: new Date("2026-01-01T00:00:00.000Z") }),
        fixtureMemory({ id: "m2", occurredAt: new Date("2026-03-01T00:00:00.000Z") }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(withDates.occurredAt).toEqual(new Date("2026-03-01T00:00:00.000Z"));

    const allNull = buildConsolidatedMemory({
      ctx,
      eligible: [fixtureMemory({ id: "m1" }), fixtureMemory({ id: "m2" })],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(allNull.occurredAt).toBeNull();
  });

  it("tags は LLM の tags があればそれを使い、無ければ eligible の tags の和集合", () => {
    const withLlmTags = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", tags: ["x"] }),
        fixtureMemory({ id: "m2", tags: ["y"] }),
      ],
      llmResult: { content: "統合後", tags: ["z"] },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(withLlmTags.tags).toEqual(["z"]);

    const unionTags = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", tags: ["x", "shared"] }),
        fixtureMemory({ id: "m2", tags: ["shared", "y"] }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(unionTags.tags).toEqual(["x", "shared", "y"]);
  });

  it("provenance は { kind: 'consolidated', sources: <eligible の id> }", () => {
    const memory = buildConsolidatedMemory({
      ctx,
      eligible: [fixtureMemory({ id: "m1" }), fixtureMemory({ id: "m2" })],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(memory.provenance).toEqual({ kind: "consolidated", sources: ["m1", "m2"] });
    expect(memory.sourceObservationId).toBeNull();
    expect(memory.extractorVersion).toBeNull();
  });

  it("LLM の digest が空なら機械的フォールバックへ倒す（resolveDigest と同じ規律）", () => {
    const memory = buildConsolidatedMemory({
      ctx,
      eligible: [fixtureMemory({ id: "m1" })],
      llmResult: { content: "統合後の本文がとても長い場合はフォールバックで切り詰められる" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 10,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(memory.digestSource).toBe("fallback");
    expect(memory.digest.length).toBeLessThanOrEqual(11); // 10文字 + "…"
  });

  it("occurredAt を持つ eligible が1件だけなら、その値を引き継ぐ（null の eligible は候補にならない）", () => {
    const memory = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1" }),
        fixtureMemory({ id: "m2", occurredAt: new Date("2026-02-01T00:00:00.000Z") }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(memory.occurredAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
  });

  it("eligible が Observation 由来でも、sourceObservationId と extractorVersion は null（統合はどの Observation にも由来しない）", () => {
    const memory = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", sourceObservationId: "obs-1", extractorVersion: "v1" }),
        fixtureMemory({ id: "m2", sourceObservationId: "obs-2", extractorVersion: "v1" }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(memory.sourceObservationId).toBeNull();
    expect(memory.extractorVersion).toBeNull();
  });

  it("activitySeq と halfLifeRecalls の片方だけでは、活動時計の3つ組を作らない", () => {
    const base = {
      ctx,
      eligible: [fixtureMemory({ id: "m1" }), fixtureMemory({ id: "m2" })],
      llmResult: { content: "統合後" },
      hashContent: (c: string) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    };
    for (const memory of [
      buildConsolidatedMemory({ ...base, activitySeq: 7 }),
      buildConsolidatedMemory({ ...base, halfLifeRecalls: 50 }),
    ]) {
      expect(memory.decayBaseSeq).toBeUndefined();
      expect(memory.decayFloorSeq).toBeUndefined();
      expect(memory.halfLifeRecalls).toBeUndefined();
    }
  });

  describe("attributes は eligible 全件に同じキー・同じ値で入っているものだけを残す（積集合）", () => {
    it("全件一致するキーだけが残る。値が割れているキー・一部にしか無いキーは落ちる", () => {
      const memory = buildConsolidatedMemory({
        ctx,
        eligible: [
          fixtureMemory({ id: "m1", attributes: { visibility: "internal", region: "jp" } }),
          fixtureMemory({ id: "m2", attributes: { visibility: "internal", region: "us" } }),
        ],
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.attributes).toEqual({ visibility: "internal" });
    });

    it("いずれかの eligible が attributes を持たない（undefined）ならそのキーは残らない", () => {
      const memory = buildConsolidatedMemory({
        ctx,
        eligible: [
          fixtureMemory({ id: "m1", attributes: { visibility: "internal" } }),
          fixtureMemory({ id: "m2", attributes: undefined }),
        ],
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.attributes).toEqual({});
    });

    it("3件以上で、あるキーが一部の件でしか一致しないなら、そのキーは残らない（every であって some ではない）", () => {
      // 「1件でも一致すれば残す」実装だと region も tier も残ってしまう。
      const eligible = [
        fixtureMemory({
          id: "m1",
          attributes: { visibility: "internal", region: "jp", tier: "gold" },
        }),
        fixtureMemory({ id: "m2", attributes: { visibility: "internal", region: "jp" } }),
        fixtureMemory({ id: "m3", attributes: { visibility: "internal", region: "us" } }),
      ];
      expect(intersectAttributes(eligible)).toEqual({ visibility: "internal" });

      const memory = buildConsolidatedMemory({
        ctx,
        eligible,
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.attributes).toEqual({ visibility: "internal" });
    });

    it("3件以上で、最後の1件だけ attributes が無い（undefined）なら、何も残らない", () => {
      expect(
        intersectAttributes([
          fixtureMemory({ id: "m1", attributes: { visibility: "internal" } }),
          fixtureMemory({ id: "m2", attributes: { visibility: "internal" } }),
          fixtureMemory({ id: "m3", attributes: undefined }),
        ]),
      ).toEqual({});
    });

    it("eligible がどちらも attributes を持たなければ {}", () => {
      const memory = buildConsolidatedMemory({
        ctx,
        eligible: [fixtureMemory({ id: "m1" }), fixtureMemory({ id: "m2" })],
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.attributes).toEqual({});
    });
  });

  describe("validFrom/validUntil は eligible 全件の区間の積（ADR 0368）", () => {
    it("両端とも eligible ごとに違う: validFrom は最大値、validUntil は最小値", () => {
      const memory = buildConsolidatedMemory({
        ctx,
        eligible: [
          fixtureMemory({
            id: "m1",
            validFrom: new Date("2026-01-01T00:00:00.000Z"),
            validUntil: new Date("2026-06-01T00:00:00.000Z"),
          }),
          fixtureMemory({
            id: "m2",
            validFrom: new Date("2026-02-01T00:00:00.000Z"),
            validUntil: new Date("2026-08-01T00:00:00.000Z"),
          }),
        ],
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.validFrom).toEqual(new Date("2026-02-01T00:00:00.000Z"));
      expect(memory.validUntil).toEqual(new Date("2026-06-01T00:00:00.000Z"));
    });

    it("片端だけ持つ eligible どうし: 無い側は制限にならない", () => {
      const memory = buildConsolidatedMemory({
        ctx,
        eligible: [
          fixtureMemory({ id: "m1", validFrom: new Date("2026-01-01T00:00:00.000Z") }),
          fixtureMemory({ id: "m2", validUntil: new Date("2026-08-01T00:00:00.000Z") }),
        ],
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.validFrom).toEqual(new Date("2026-01-01T00:00:00.000Z"));
      expect(memory.validUntil).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    });

    it("期限の無い材料が、期限の在る材料より後ろに並んでいても、無い側は制限にならない（並びに依らない）", () => {
      const withBoth = fixtureMemory({
        id: "m1",
        validFrom: new Date("2026-02-01T00:00:00.000Z"),
        validUntil: new Date("2026-06-01T00:00:00.000Z"),
      });
      const unbounded = fixtureMemory({ id: "m2" });
      for (const eligible of [
        [withBoth, unbounded],
        [unbounded, withBoth],
      ]) {
        const memory = buildConsolidatedMemory({
          ctx,
          eligible,
          llmResult: { content: "統合後" },
          hashContent: (c) => `hash(${c})`,
          digestFallbackLength: 200,
          halfLifeHours: 24,
          now: NOW,
        });
        expect(memory.validFrom).toEqual(new Date("2026-02-01T00:00:00.000Z"));
        expect(memory.validUntil).toEqual(new Date("2026-06-01T00:00:00.000Z"));
      }
    });

    it("やりすぎの歯: 全 eligible が両方 null なら、今どおり両方 null", () => {
      const memory = buildConsolidatedMemory({
        ctx,
        eligible: [fixtureMemory({ id: "m1" }), fixtureMemory({ id: "m2" })],
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.validFrom ?? null).toBeNull();
      expect(memory.validUntil ?? null).toBeNull();
    });

    it("材料1件でも、その eligible 自身の区間をそのまま持つ", () => {
      const memory = buildConsolidatedMemory({
        ctx,
        eligible: [
          fixtureMemory({
            id: "m1",
            validFrom: new Date("2026-01-01T00:00:00.000Z"),
            validUntil: new Date("2026-06-01T00:00:00.000Z"),
          }),
        ],
        llmResult: { content: "統合後" },
        hashContent: (c) => `hash(${c})`,
        digestFallbackLength: 200,
        halfLifeHours: 24,
        now: NOW,
      });
      expect(memory.validFrom).toEqual(new Date("2026-01-01T00:00:00.000Z"));
      expect(memory.validUntil).toEqual(new Date("2026-06-01T00:00:00.000Z"));
    });
  });
});

describe("buildConsolidationPrompt（純関数）", () => {
  it("件数で切り詰めず、eligible の content と digest を全件並べる", () => {
    const eligible: Memory[] = ["一", "二", "三", "四"].map((n, i) => ({
      ...newMemory({ content: `本文${n}`, digest: `要旨${n}` }),
      id: `m${i + 1}`,
      status: "active",
      supersededById: null,
      contestedWithId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }));

    const userContent = buildConsolidationPrompt(eligible).messages[0]!.content;

    expect(userContent).toBe(
      [
        "[1] content: 本文一\ndigest: 要旨一",
        "[2] content: 本文二\ndigest: 要旨二",
        "[3] content: 本文三\ndigest: 要旨三",
        "[4] content: 本文四\ndigest: 要旨四",
      ].join("\n\n"),
    );
  });
});

describe("runtime.consolidate — 口が在る adapter（ADR 0100）", () => {
  it("atomicity: 'store_supported' を名乗り、統合先の作成と supersede が1回の呼び出しで済む", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.atomicity).toBe("store_supported");
    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
    ]);
    expect((await stores.memoryStore.get(ctx, a.id))?.supersededById).toBe(
      result.consolidatedMemoryId,
    );
    expect((await stores.memoryStore.get(ctx, b.id))?.supersededById).toBe(
      result.consolidatedMemoryId,
    );
    expect(supersededEvents(stores, a.id)[0]?.meta.supersededById).toBe(
      result.consolidatedMemoryId,
    );
  });

  it("口が無い adapter では atomicity: 'store_unsupported' を名乗る", async () => {
    const { stores } = buildRuntime();
    (stores.memoryStore as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories =
      undefined;
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmConsolidatingTo({ content: "統合後" }),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.atomicity).toBe("store_unsupported");
    expect(result.outcome).toBe("consolidated");
  });

  /** 投げること自体は本題ではなく、巻き戻ること。例外が投げられたことだけを見る歯は書き込みが残っていても緑になるので、store を実際に見て「新しい Memory も supersede も1つも書かれていない」ことを assert する。 */
  it("口が投げたら例外は呼び出し側まで届き、新しい Memory も supersede も1件も書かれていない", async () => {
    const { stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    // Fake の裏の Map を直接数える（`FakeMemoryStore` に列挙の口が無いため）。
    const backingMemories = (
      stores.memoryStore as unknown as { backing: { memories: Map<string, unknown> } }
    ).backing.memories;
    const memoriesBefore = backingMemories.size;
    const eventsBefore = stores.eventStore.events.length;

    const failing = new Proxy(stores.memoryStore, {
      get(target, prop, receiver) {
        if (prop === "supersedeWithNewMemories") {
          return async () => {
            throw new Error("simulated transaction failure");
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryStore;

    const runtimeFailing = createRuntime({
      memoryStore: failing,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmConsolidatingTo({ content: "統合後" }),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });

    // ADR 0089 決定5 をこの経路では部分的に覆して投げる: 「投げない」の理由（部分的に起きたことを見えなくしない）が1トランザクションでは成立しないため。
    await expect(
      runtimeFailing.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } }),
    ).rejects.toThrow("simulated transaction failure");

    expect(backingMemories.size).toBe(memoriesBefore);
    expect(stores.eventStore.events.length).toBe(eventsBefore);
    expect((await stores.memoryStore.get(ctx, a.id))?.status).toBe("active");
    expect((await stores.memoryStore.get(ctx, b.id))?.status).toBe("active");
    expect(supersededEvents(stores, a.id)).toEqual([]);
    expect(supersededEvents(stores, b.id)).toEqual([]);
  });

  it("口が在っても、投げたときに今日の2段の経路へフォールバックしない（ADR 0100 禁止1）", async () => {
    const { stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    let usedFallback = false;
    const failing = new Proxy(stores.memoryStore, {
      get(target, prop, receiver) {
        if (prop === "supersedeWithNewMemories") {
          return async () => {
            throw new Error("simulated transaction failure");
          };
        }
        if (prop === "updateStatusWithEvent") {
          return async (...args: Parameters<MemoryStore["updateStatusWithEvent"]>) => {
            usedFallback = true;
            return target.updateStatusWithEvent(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryStore;

    const runtimeFailing = createRuntime({
      memoryStore: failing,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmConsolidatingTo({ content: "統合後" }),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });

    await expect(
      runtimeFailing.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } }),
    ).rejects.toThrow("simulated transaction failure");
    expect(usedFallback).toBe(false);
  });
});
