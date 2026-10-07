import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus, NewMemory } from "../memory.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { createRuntime } from "../runtime.js";
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

function forgottenEvents(stores: ReturnType<typeof createFakeRuntimeStores>, memoryId: MemoryId) {
  return stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "forgotten");
}

describe("runtime.forget — 基本の1件", () => {
  it("active な Memory を forget すると forgotten になり、イベントが1件だけ積まれる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    const result = await runtime.forget(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "forgotten", previousStatus: "active" },
    ]);
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.status).toBe("forgotten");
    expect(forgottenEvents(stores, memory.id)).toHaveLength(1);
  });

  it("存在しない id は not_found・イベントは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.forget(ctx, { memoryId: "no-such-memory" });

    expect(result.outcomes).toEqual([{ memoryId: "no-such-memory", kind: "not_found" }]);
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.forget — 冪等性", () => {
  it("同じ target を別々の呼び出しで2回 forget すると、2回目は already_forgotten・イベントは通算1件", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    const first = await runtime.forget(ctx, { memoryId: memory.id });
    expect(first.outcomes).toEqual([
      { memoryId: memory.id, kind: "forgotten", previousStatus: "active" },
    ]);

    const second = await runtime.forget(ctx, { memoryId: memory.id });
    expect(second.outcomes).toEqual([{ memoryId: memory.id, kind: "already_forgotten" }]);

    expect(forgottenEvents(stores, memory.id)).toHaveLength(1);
  });

  it("同じ id を1回の呼び出しの中に2回渡すと [forgotten, already_forgotten]・イベントは1件", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    const result = await runtime.forget(ctx, { memoryIds: [memory.id, memory.id] });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "forgotten", previousStatus: "active" },
      { memoryId: memory.id, kind: "already_forgotten" },
    ]);
    expect(forgottenEvents(stores, memory.id)).toHaveLength(1);
  });

  /**
   * この歯は `outcomes` を見ず、往復の回数を数える。ローカルの写しを消しても `outcomes` は変わらない（2回目は古い status で CAS を撃ち、弾かれ、読み直して同じ `already_forgotten` に着く）ので、
   * `outcomes` と件数を見る歯だけではこの最適化は測れない。買っているのは「必ず失敗する UPDATE 1回 + 読み直しの SELECT 1回」を DB へ飛ばさないことなので、呼び出し回数を測る。
   */
  it("重複した id は、2回目に書き込みも読み直しも撃たない（往復を増やさない）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    let updateCalls = 0;
    let getCalls = 0;
    // ⚠ `{ ...store }` にしないこと——fake はクラスのインスタンスであり、
    // 展開してもプロトタイプ上のメソッドは写らない（`getMany is not a function` で落ちる）。
    const base = stores.memoryStore;
    const counting = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "updateStatusWithEvent") {
          return (...args: Parameters<MemoryStore["updateStatusWithEvent"]>) => {
            updateCalls += 1;
            return target.updateStatusWithEvent(...args);
          };
        }
        if (prop === "get") {
          return (...args: Parameters<MemoryStore["get"]>) => {
            getCalls += 1;
            return target.get(...args);
          };
        }
        if (prop === "getMany") {
          // 本物の store を模して、行を読み直すたびに新しいオブジェクトを返す。素の `FakeMemoryStore` は `memories` Map の同じ参照を返し、
          // `updateStatus*` がその場で書き換えるので、`forget` のローカルの写しが古くなりようがなく、写しを更新する行を消しても何も壊れない（fake の性質であって Postgres の性質ではない）。
          return async (...args: Parameters<MemoryStore["getMany"]>) =>
            (await target.getMany(...args)).map((m) => structuredClone(m));
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryStore;

    const runtimeCounting = createRuntime({
      memoryStore: counting,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: notUsedLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    void runtime;

    const result = await runtimeCounting.forget(ctx, { memoryIds: [memory.id, memory.id] });

    expect(result.outcomes.map((o) => o.kind)).toEqual(["forgotten", "already_forgotten"]);
    expect(updateCalls).toBe(1);
    expect(getCalls).toBe(0);
  });
});

describe("runtime.forget — target の2つの形", () => {
  it("{ memoryId } と { memoryIds: [...] } は同じように効く", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    const viaSingular = await runtime.forget(ctx, { memoryId: a.id });
    const viaPlural = await runtime.forget(ctx, { memoryIds: [b.id] });

    expect(viaSingular.outcomes).toEqual([
      { memoryId: a.id, kind: "forgotten", previousStatus: "active" },
    ]);
    expect(viaPlural.outcomes).toEqual([
      { memoryId: b.id, kind: "forgotten", previousStatus: "active" },
    ]);
  });

  it("空の { memoryIds: [] } は { outcomes: [] } を返し、store への書き込みは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.forget(ctx, { memoryIds: [] });

    expect(result).toEqual({ outcomes: [] });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.forget — outcomes の順序・長さ", () => {
  it("複数 id を混ぜた並びでも、outcomes は入力と同じ順序・同じ長さになる", async () => {
    const { runtime, stores } = buildRuntime();
    const active = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const alreadyGone = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const missingId: MemoryId = "does-not-exist";

    const result = await runtime.forget(ctx, {
      memoryIds: [missingId, active.id, alreadyGone.id],
    });

    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toEqual({ memoryId: missingId, kind: "not_found" });
    expect(result.outcomes[1]).toEqual({
      memoryId: active.id,
      kind: "forgotten",
      previousStatus: "active",
    });
    expect(result.outcomes[2]).toEqual({ memoryId: alreadyGone.id, kind: "already_forgotten" });
  });
});

describe("runtime.forget — reason / actor", () => {
  it("reason を渡すと meta.reason に入り、省略すると meta に reason キーが無い", async () => {
    const { runtime, stores } = buildRuntime();
    const withReason = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const withoutReason = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active" }),
    );

    await runtime.forget(ctx, { memoryId: withReason.id }, { reason: "ユーザーの訂正" });
    await runtime.forget(ctx, { memoryId: withoutReason.id });

    const [reasonEvent] = forgottenEvents(stores, withReason.id);
    expect(reasonEvent?.meta).toEqual({ reason: "ユーザーの訂正" });

    const [noReasonEvent] = forgottenEvents(stores, withoutReason.id);
    expect(noReasonEvent?.meta).toEqual({});
    expect(Object.hasOwn(noReasonEvent?.meta ?? {}, "reason")).toBe(false);
  });

  it("actor を渡すとイベントの actor がそれになり、省略時は { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const withActor = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const withoutActor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active" }),
    );

    await runtime.forget(
      ctx,
      { memoryId: withActor.id },
      { actor: { type: "human", id: "user-42" } },
    );
    await runtime.forget(ctx, { memoryId: withoutActor.id });

    const [actorEvent] = forgottenEvents(stores, withActor.id);
    expect(actorEvent?.actor).toEqual({ type: "human", id: "user-42" });

    const [defaultActorEvent] = forgottenEvents(stores, withoutActor.id);
    expect(defaultActorEvent?.actor).toEqual({ type: "system" });
  });

  it("digestSnapshot はその Memory の digest であり、content は運ばない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", content: "秘密の本文", digest: "要旨だけ" }),
    );

    await runtime.forget(ctx, { memoryId: memory.id });

    const [event] = forgottenEvents(stores, memory.id);
    expect(event?.digestSnapshot).toBe("要旨だけ");
    expect(JSON.stringify(event)).not.toContain("秘密の本文");
  });
});

describe("runtime.forget — status のバリエーション", () => {
  it.each<MemoryStatus>(["archived", "superseded", "contested"])(
    "status=%s な Memory も forget でき、previousStatus が正しく入る",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status }));

      const result = await runtime.forget(ctx, { memoryId: memory.id });

      expect(result.outcomes).toEqual([
        { memoryId: memory.id, kind: "forgotten", previousStatus: status },
      ]);
      const stored = await stores.memoryStore.get(ctx, memory.id);
      expect(stored?.status).toBe("forgotten");
    },
  );
});

describe("runtime.forget — 並行（updateStatusWithEvent が MemoryStatusConflictError を投げる）", () => {
  /** 既存のテスト用フック `FakeMemoryStore.beforeUpdateStatus` で、`getMany` の後・`updateStatusWithEvent` の前に別の書き込みが割り込んだ状況を再現する。本番コード（`runtime.ts`）には手を入れない。 */
  it("再読すると forgotten になっている ⟹ already_forgotten", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // ADR 0562: `createMemory` の返り値は写し。store の中の行を書き換える。
        stores.memoryStore.liveRowForTest(ctx, memory.id)!.status = "forgotten";
      }
    };

    const result = await runtime.forget(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_forgotten" }]);
    expect(forgottenEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読しても別の status（archived）⟹ conflicted(observedStatus: 'archived')", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // ADR 0562: `createMemory` の返り値は写し。store の中の行を書き換える。
        stores.memoryStore.liveRowForTest(ctx, memory.id)!.status = "archived";
      }
    };

    const result = await runtime.forget(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "conflicted", observedStatus: "archived" },
    ]);
    expect(forgottenEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読すると行が消えていた（get が null を返す）⟹ not_found・再試行ループにしない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    // 1回目の get（CAS 判定用）は普通に応答させて status を不一致にし、2回目の get（forget の再読）だけ null を返すよう、このテストに限って `get` をインスタンス単位で差し替える。
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // ADR 0562: `createMemory` の返り値は写し。store の中の行を書き換える。
        stores.memoryStore.liveRowForTest(ctx, memory.id)!.status = "archived";
      }
    };
    let getCalls = 0;
    const originalGet = stores.memoryStore.get.bind(stores.memoryStore);
    stores.memoryStore.get = async (c, id) => {
      getCalls += 1;
      if (id === memory.id && getCalls === 2) {
        return null;
      }
      return originalGet(c, id);
    };

    const result = await runtime.forget(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "not_found" }]);
    expect(getCalls).toBe(2); // 1回だけ再読した（上限の無いループになっていない）
    expect(forgottenEvents(stores, memory.id)).toHaveLength(0);
  });
});

describe("runtime.forget — 打ち切り（競合でない例外）", () => {
  it("2件目で普通の Error が投げられたら [forgotten, failed, not_attempted]・例外は伝播せず・3件目は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    const originalUpdate = stores.memoryStore.updateStatusWithEvent.bind(stores.memoryStore);
    stores.memoryStore.updateStatusWithEvent = async (c, id, status, opts, event) => {
      if (id === m2.id) {
        throw new Error("simulated connection reset");
      }
      return originalUpdate(c, id, status, opts, event);
    };

    const result = await runtime.forget(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result.outcomes).toEqual([
      { memoryId: m1.id, kind: "forgotten", previousStatus: "active" },
      { memoryId: m2.id, kind: "failed", error: "simulated connection reset" },
      { memoryId: m3.id, kind: "not_attempted" },
    ]);

    const m3After = await stores.memoryStore.get(ctx, m3.id);
    expect(m3After?.status).toBe("active"); // 3件目には一切触れていない
  });
});

describe("runtime.forget — recall() との裏取り（recall 側は変更していない）", () => {
  it("forget した Memory は recall() に出てこず、omitted に filtered/forgotten が出る", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    const beforeForget = await runtime.recall(ctx, { vector: [1, 0] });
    expect(beforeForget.memories.map((m) => m.memoryId)).toContain(memory.id);

    await runtime.forget(ctx, { memoryId: memory.id });

    const afterForget = await runtime.recall(ctx, { vector: [1, 0] });
    expect(afterForget.memories.map((m) => m.memoryId)).not.toContain(memory.id);
    expect(afterForget.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      scopeRelation: "outside_scope",
      count: 1,
      countKind: "exact",
    });
  });
});

describe("runtime.forget — CAS が破れた後の再読そのものが失敗する", () => {
  it("2件目の再読で get が投げても [forgotten, failed, not_attempted]・例外は伝播しない", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === m2.id) {
        stores.memoryStore.liveRowForTest(ctx, m2.id)!.status = "archived"; // ADR 0562: 返り値は写し
      }
    };
    let m2GetCalls = 0;
    const originalGet = stores.memoryStore.get.bind(stores.memoryStore);
    stores.memoryStore.get = async (c, id) => {
      if (id === m2.id) {
        m2GetCalls += 1;
        if (m2GetCalls === 2) {
          throw new Error("simulated connection reset on refetch");
        }
      }
      return originalGet(c, id);
    };

    const result = await runtime.forget(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result.outcomes).toEqual([
      { memoryId: m1.id, kind: "forgotten", previousStatus: "active" },
      { memoryId: m2.id, kind: "failed", error: "simulated connection reset on refetch" },
      { memoryId: m3.id, kind: "not_attempted" },
    ]);
    expect(forgottenEvents(stores, m1.id)).toHaveLength(1);
    expect(forgottenEvents(stores, m2.id)).toHaveLength(0);
    const m3After = await originalGet(ctx, m3.id);
    expect(m3After?.status).toBe("active"); // 3件目には一切触れていない
  });
});

describe("runtime.forget — ループ前の一括読み（getMany）が失敗する（Issue #964）", () => {
  it("getMany が投げても [failed, not_attempted, not_attempted]・例外は伝播せず・書き込み0件", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    stores.memoryStore.getMany = async () => {
      throw new Error("simulated connection reset on getMany");
    };

    const result = await runtime.forget(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result.outcomes).toEqual([
      { memoryId: m1.id, kind: "failed", error: "simulated connection reset on getMany" },
      { memoryId: m2.id, kind: "not_attempted" },
      { memoryId: m3.id, kind: "not_attempted" },
    ]);
    expect(stores.eventStore.events.filter((e) => e.kind === "forgotten")).toHaveLength(0);
  });
});
