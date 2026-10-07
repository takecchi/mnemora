import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores, FakeEmbeddingProvider } from "./runtime-fakes.js";

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

function purgedEvents(stores: ReturnType<typeof createFakeRuntimeStores>, memoryId: MemoryId) {
  return stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "purged");
}

/** `deps.memoryStore.purgeMemory` が無い adapter を模す（own property でプロトタイプの実装を隠す）。 */
function disablePurgeMemory(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "purgeMemory", {
    value: undefined,
    configurable: true,
  });
}

describe("runtime.purge — 基本の1件", () => {
  it("forgotten な Memory を purge すると content/digest がトゥームストーンで上書きされ、purgedAt が入り、kind='purged' のイベントが1件だけ積まれる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", content: "秘密の本文", digest: "要旨" }),
    );

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result).toEqual({
      supported: true,
      outcomes: [{ memoryId: memory.id, kind: "purged", previousStatus: "forgotten" }],
    });
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.status).toBe("forgotten"); // status は動かない
    expect(stored?.content).toBe("[purged]");
    expect(stored?.digest).toBe("[purged]");
    expect(stored?.purgedAt).toBeInstanceOf(Date);
    expect(purgedEvents(stores, memory.id)).toHaveLength(1);
  });

  it("行は消えない（get で読み続けられる）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    await runtime.purge(ctx, { memoryId: memory.id });

    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(memory.id);
  });

  it("存在しない id は not_found・イベントは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.purge(ctx, { memoryId: "no-such-memory" });

    expect(result).toEqual({
      supported: true,
      outcomes: [{ memoryId: "no-such-memory", kind: "not_found" }],
    });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.purge — status のバリエーション（forgotten 以外は直接 purge できない）", () => {
  it.each<Exclude<MemoryStatus, "forgotten">>(["active", "superseded", "contested", "archived"])(
    "status=%s な Memory は status_not_forgotten を返し、書き込みが起きない",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status }));

      const result = await runtime.purge(ctx, { memoryId: memory.id });

      expect(result).toEqual({
        supported: true,
        outcomes: [{ memoryId: memory.id, kind: "status_not_forgotten", status }],
      });
      const stored = await stores.memoryStore.get(ctx, memory.id);
      expect(stored?.status).toBe(status);
      expect(stored?.purgedAt ?? null).toBeNull();
      expect(stores.eventStore.events).toHaveLength(0);
    },
  );
});

describe("runtime.purge — 冪等性（2回 purge したらどうなるか）", () => {
  it("既に purge 済みの Memory をもう一度 purge すると already_purged を返し、イベントは増えない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const first = await runtime.purge(ctx, { memoryId: memory.id });
    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(first.outcomes).toEqual([
      { memoryId: memory.id, kind: "purged", previousStatus: "forgotten" },
    ]);
    expect(second.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(1);
  });

  it("同じ id を1回の呼び出しの中に2回渡すと [purged, already_purged]・イベントは1件", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(ctx, { memoryIds: [memory.id, memory.id] });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "purged", previousStatus: "forgotten" },
      { memoryId: memory.id, kind: "already_purged" },
    ]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(1);
  });
});

describe("runtime.purge — target の2つの形", () => {
  it("{ memoryId } と { memoryIds: [...] } は同じように効く", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const viaSingular = await runtime.purge(ctx, { memoryId: a.id });
    const viaPlural = await runtime.purge(ctx, { memoryIds: [b.id] });

    expect(viaSingular.outcomes).toEqual([
      { memoryId: a.id, kind: "purged", previousStatus: "forgotten" },
    ]);
    expect(viaPlural.outcomes).toEqual([
      { memoryId: b.id, kind: "purged", previousStatus: "forgotten" },
    ]);
  });

  it("空の { memoryIds: [] } は { supported: true, outcomes: [] } を返し、store への書き込みは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.purge(ctx, { memoryIds: [] });

    expect(result).toEqual({ supported: true, outcomes: [] });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.purge — outcomes の順序・長さ", () => {
  it("複数 id を混ぜた並びでも、outcomes は入力と同じ順序・同じ長さになる", async () => {
    const { runtime, stores } = buildRuntime();
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const active = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const missingId: MemoryId = "does-not-exist";

    const result = await runtime.purge(ctx, {
      memoryIds: [missingId, forgotten.id, active.id],
    });

    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toEqual({ memoryId: missingId, kind: "not_found" });
    expect(result.outcomes[1]).toEqual({
      memoryId: forgotten.id,
      kind: "purged",
      previousStatus: "forgotten",
    });
    expect(result.outcomes[2]).toEqual({
      memoryId: active.id,
      kind: "status_not_forgotten",
      status: "active",
    });
  });
});

describe("runtime.purge — reason / actor / digestSnapshot", () => {
  it("reason を渡すと meta.reason に入り、省略すると meta に reason キーが無い", async () => {
    const { runtime, stores } = buildRuntime();
    const withReason = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const withoutReason = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );

    await runtime.purge(ctx, { memoryId: withReason.id }, { reason: "法的要求への対応" });
    await runtime.purge(ctx, { memoryId: withoutReason.id });

    const [reasonEvent] = purgedEvents(stores, withReason.id);
    expect(reasonEvent?.meta).toEqual({ reason: "法的要求への対応" });

    const [noReasonEvent] = purgedEvents(stores, withoutReason.id);
    expect(noReasonEvent?.meta).toEqual({});
    expect(Object.hasOwn(noReasonEvent?.meta ?? {}, "reason")).toBe(false);
  });

  it("actor を渡すとイベントの actor がそれになり、省略時は { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const withActor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const withoutActor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );

    await runtime.purge(
      ctx,
      { memoryId: withActor.id },
      { actor: { type: "human", id: "user-42" } },
    );
    await runtime.purge(ctx, { memoryId: withoutActor.id });

    const [actorEvent] = purgedEvents(stores, withActor.id);
    expect(actorEvent?.actor).toEqual({ type: "human", id: "user-42" });

    const [defaultActorEvent] = purgedEvents(stores, withoutActor.id);
    expect(defaultActorEvent?.actor).toEqual({ type: "system" });
  });

  it("digestSnapshot は上書き前の digest であり、content は運ばない。purge 後の Memory の行には元の digest は残らない（元の digest が残るのは監査ログだけではない。MemoryStore.purgeMemory の TSDoc）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", content: "秘密の本文", digest: "要旨だけ" }),
    );

    await runtime.purge(ctx, { memoryId: memory.id });

    const [event] = purgedEvents(stores, memory.id);
    expect(event?.digestSnapshot).toBe("要旨だけ");
    expect(JSON.stringify(event)).not.toContain("秘密の本文");

    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.digest).toBe("[purged]"); // 上書き後は store 側にも元の digest は残らない
  });
});

describe("runtime.purge — dryRun（下見）", () => {
  it("forgotten かつ未 purge の対象は would_purge を返し、書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", content: "秘密の本文", digest: "要旨" }),
    );

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result).toEqual({
      supported: true,
      outcomes: [{ memoryId: memory.id, kind: "would_purge", previousStatus: "forgotten" }],
    });
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.content).toBe("秘密の本文");
    expect(stored?.digest).toBe("要旨");
    expect(stored?.purgedAt ?? null).toBeNull();
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("既に purge 済みの対象は dryRun でも already_purged を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
  });

  it("forgotten ではない対象は dryRun でも status_not_forgotten を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "status_not_forgotten", status: "active" },
    ]);
  });

  it("存在しない対象は dryRun でも not_found を返す", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.purge(ctx, { memoryId: "no-such-memory" }, { dryRun: true });

    expect(result.outcomes).toEqual([{ memoryId: "no-such-memory", kind: "not_found" }]);
  });

  it("dryRun は embedding にも触れない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    const hits = await stores.vectorStore.search(ctx, stores.embeddingProvider.space, [1, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId, status: ["active", "contested", "forgotten"] },
    });
    expect(hits.map((h) => h.memoryId)).toContain(memory.id);
  });
});

describe("runtime.purge — 別 space の embedding も消える（Issue #1425、ADR 0382）", () => {
  class SecondSpaceEmbeddingProvider extends FakeEmbeddingProvider {
    override readonly space: EmbeddingSpaceId = {
      provider: "fake",
      model: "fake-model-v2",
      dimensions: 2,
    };
  }

  it("embeddingProvider を新しい space に切り替えて purge すると、旧 space の embedding 行も消える", async () => {
    const stores = createFakeRuntimeStores();
    const commonDeps = {
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: notUsedLlm,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    };
    // 「旧 space」で embed していた時代の runtime。
    const runtimeOld = createRuntime({
      ...commonDeps,
      embeddingProvider: stores.embeddingProvider,
    });
    // 「新 space」へ埋め込みモデルを移した後の runtime——purge はこちらで呼ぶ
    // （`deps.embeddingProvider.space` が読まれるのは purge を呼んだ runtime の側だが、
    // `deleteAcrossSpaces` は space を問わず全 space から消す）。
    const newProvider = new SecondSpaceEmbeddingProvider();
    const runtimeNew = createRuntime({ ...commonDeps, embeddingProvider: newProvider });

    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    // 旧 space（切り替え前）の embedding。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    // 新 space（切り替え後）の embedding。
    await stores.vectorStore.upsert(ctx, newProvider.space, memory.id, [0, 1]);
    expect(stores.vectorStore.entries.size).toBe(2);

    await runtimeOld.forget(ctx, { memoryId: memory.id });
    const purged = await runtimeNew.purge(ctx, { memoryId: memory.id });
    expect(purged.outcomes[0]?.kind).toBe("purged");

    const remaining = [...stores.vectorStore.entries.values()].filter(
      (entry) => entry.memoryId === memory.id,
    );
    expect(
      remaining,
      "旧 space・新 space の両方が消えているはず（deleteAcrossSpaces）",
    ).toHaveLength(0);
  });
});

describe("runtime.purge — 対応する embedding が実際に消える", () => {
  it("purge すると VectorStore.deleteAcrossSpaces が呼ばれ、embedding が消える", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    expect(stores.vectorStore.entries.size).toBe(1);

    await runtime.purge(ctx, { memoryId: memory.id });

    expect(stores.vectorStore.entries.size).toBe(0);
  });

  it("VectorStore.deleteAcrossSpaces が例外を投げても、purged の判定は変わらない（ADR 0124 決定5・ADR 0382、ベストエフォート）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.vectorStore.deleteAcrossSpaces = async () => {
      throw new Error("simulated vector store outage");
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    // kind はそのまま。失敗は任意の欄 `embeddingCleanup` で知らせる。
    expect(result.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "purged",
        previousStatus: "forgotten",
        embeddingCleanup: { status: "failed", error: "simulated vector store outage" },
      },
    ]);
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.purgedAt).toBeInstanceOf(Date); // MemoryStore 側の書き込みは確定している
  });

  it("埋め込み削除が Error 以外を投げても、error は文字列になる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.vectorStore.deleteAcrossSpaces = async () => {
      throw "plain string outage";
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes[0]).toMatchObject({
      kind: "purged",
      embeddingCleanup: { status: "failed", error: "plain string outage" },
    });
  });

  it("埋め込み削除が成功したときは、embeddingCleanup というプロパティ自体が無い（出力は今日と1バイトも変わらない）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(Object.keys(result.outcomes[0]!).sort()).toEqual(["kind", "memoryId", "previousStatus"]);
    expect(JSON.stringify(result.outcomes[0])).toBe(
      JSON.stringify({ memoryId: memory.id, kind: "purged", previousStatus: "forgotten" }),
    );
  });
});

describe("runtime.purge — already_purged の再実行でも embedding をベストエフォートで消す（Issue #1425、ADR 0382）", () => {
  it("既に purge 済みの記憶で、後から見つかった embedding も deleteAcrossSpaces で消える", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const first = await runtime.purge(ctx, { memoryId: memory.id });
    expect(first.outcomes[0]?.kind).toBe("purged");

    // purge 後に見つかった旧 space の embedding を模す（memories 行自体は purge 後も残るので
    // upsert は成功する）。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    expect(stores.vectorStore.entries.size).toBe(1);

    const second = await runtime.purge(ctx, { memoryId: memory.id });
    expect(second.outcomes[0]?.kind).toBe("already_purged");
    expect(stores.vectorStore.entries.size).toBe(0);
  });

  it("既に purge 済みの再実行で deleteAcrossSpaces が失敗すると、kind はそのまま already_purged で embeddingCleanup が付く（ADR 0399）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });
    stores.vectorStore.deleteAcrossSpaces = async () => {
      throw new Error("simulated retry outage");
    };

    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(second.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "already_purged",
        embeddingCleanup: { status: "failed", error: "simulated retry outage" },
      },
    ]);
  });

  it("already_purged の再実行で成功したときは、embeddingCleanup というプロパティ自体が無い", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });

    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(Object.keys(second.outcomes[0]!).sort()).toEqual(["kind", "memoryId"]);
  });

  it("dryRun: true のときは、already_purged でも embedding を消さない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    const dryRunResult = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });
    expect(dryRunResult.outcomes[0]?.kind).toBe("already_purged");
    expect(stores.vectorStore.entries.size).toBe(1);
  });
});

describe("runtime.purge — already_purged の再実行で、v1.1.0 より前の purge が残した残骸も消す（ADR 0437 決定3）", () => {
  type Scrub = (ctx: Ctx, ids: readonly MemoryId[]) => Promise<void>;
  function installScrub(stores: ReturnType<typeof createFakeRuntimeStores>, fn: Scrub) {
    Object.defineProperty(stores.memoryStore, "scrubPurged", { value: fn, configurable: true });
  }

  it("already_purged（dryRun でない）のときだけ scrubPurged を、その id で呼ぶ。purged・would_purge・status_not_forgotten・not_found では呼ばない", async () => {
    const { runtime, stores } = buildRuntime();
    const calls: MemoryId[][] = [];
    installScrub(stores, async (_ctx, ids) => {
      calls.push([...ids]);
    });
    const purgedAlready = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", contentHash: "scrub-a" }),
    );
    const fresh = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", contentHash: "scrub-b" }),
    );
    const active = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", contentHash: "scrub-c" }),
    );
    await runtime.purge(ctx, { memoryId: purgedAlready.id });
    expect(calls).toEqual([]);

    const result = await runtime.purge(ctx, {
      memoryIds: [purgedAlready.id, fresh.id, active.id, "missing" as MemoryId],
    });
    expect(result.outcomes.map((o) => o.kind)).toEqual([
      "already_purged",
      "purged",
      "status_not_forgotten",
      "not_found",
    ]);
    expect(calls).toEqual([[purgedAlready.id]]);

    await runtime.purge(ctx, { memoryId: purgedAlready.id }, { dryRun: true });
    await runtime.purge(ctx, { memoryId: fresh.id }, { dryRun: true });
    expect(calls).toEqual([[purgedAlready.id]]);
  });

  it("競合で already_purged になった分岐（MemoryPurgeConflictError の再読）でも呼ぶ", async () => {
    const { runtime, stores } = buildRuntime();
    const calls: MemoryId[][] = [];
    installScrub(stores, async (_ctx, ids) => {
      calls.push([...ids]);
    });
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
        live.purgedAt = new Date();
        live.content = "[purged]";
        live.digest = "[purged]";
      }
    };
    const result = await runtime.purge(ctx, { memoryId: memory.id });
    expect(result.outcomes[0]?.kind).toBe("already_purged");
    expect(calls).toEqual([[memory.id]]);
  });

  it("scrubPurged が失敗しても kind は already_purged のまま、residueCleanup が付く。embedding の後始末は止まらない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    installScrub(stores, async () => {
      throw new Error("simulated scrub outage");
    });

    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(second.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "already_purged",
        residueCleanup: { status: "failed", error: "simulated scrub outage" },
      },
    ]);
    expect(stores.vectorStore.entries.size).toBe(0);
  });

  it("埋め込みの掃除（deleteAcrossSpaces）が失敗しても scrubPurged は走る。両方が失敗すれば、欄は両方付く", async () => {
    const { runtime, stores } = buildRuntime();
    const calls: MemoryId[][] = [];
    installScrub(stores, async (_ctx, ids) => {
      calls.push([...ids]);
    });
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });
    stores.vectorStore.deleteAcrossSpaces = async () => {
      throw new Error("simulated embedding outage");
    };

    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(calls).toEqual([[memory.id]]);
    expect(second.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "already_purged",
        embeddingCleanup: { status: "failed", error: "simulated embedding outage" },
      },
    ]);

    installScrub(stores, async () => {
      throw new Error("simulated scrub outage");
    });
    const third = await runtime.purge(ctx, { memoryId: memory.id });
    expect(third.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "already_purged",
        embeddingCleanup: { status: "failed", error: "simulated embedding outage" },
        residueCleanup: { status: "failed", error: "simulated scrub outage" },
      },
    ]);
  });

  it("競合で already_purged になった分岐でも、埋め込みの掃除が失敗して scrubPurged は走る", async () => {
    const { runtime, stores } = buildRuntime();
    const calls: MemoryId[][] = [];
    installScrub(stores, async (_ctx, ids) => {
      calls.push([...ids]);
    });
    stores.vectorStore.deleteAcrossSpaces = async () => {
      throw new Error("simulated embedding outage");
    };
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
        live.purgedAt = new Date();
        live.content = "[purged]";
        live.digest = "[purged]";
      }
    };
    const result = await runtime.purge(ctx, { memoryId: memory.id });
    expect(result.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "already_purged",
        embeddingCleanup: { status: "failed", error: "simulated embedding outage" },
      },
    ]);
    expect(calls).toEqual([[memory.id]]);
  });

  // Fake に `scrubPurged` が無かった頃は、Fake の不在そのものがこの経路の証人だった。Fake が実装したので、明示的に外した store で縛る。
  it("scrubPurged の無い adapter では Runtime.purge が後始末を飛ばし、already_purged の形は変わらず（残骸の欄も付かず）例外にもならない。残骸はそのまま残る", async () => {
    const { runtime, stores } = buildRuntime();
    Object.defineProperty(stores.memoryStore, "scrubPurged", {
      value: undefined,
      configurable: true,
    });
    expect(stores.memoryStore.scrubPurged).toBeUndefined();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });
    const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
    live.tags = ["legacy-tag"];
    live.attributes = { owner: "alice" };

    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(second.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
    expect(live.tags).toEqual(["legacy-tag"]);
    expect(live.attributes).toEqual({ owner: "alice" });
  });

  it("Fake の上で already_purged をかけ直すと、v1.0.x の purge が残した残骸（tags・attributes・claim key・目次帯の digest）が実際に消える", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", digest: "秘密の要旨" }),
    );
    await runtime.purge(ctx, { memoryId: memory.id });
    const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
    live.tags = ["legacy-tag"];
    live.attributes = { owner: "alice" };
    live.claimKey = { subject: "user", predicate: "home_city" };
    const recallId = await stores.memoryStore.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "q" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: {
        groups: [],
        totalInScope: 0,
        countKind: "exact",
        digestBand: [{ memoryId: memory.id, digest: "秘密の要旨", truncated: true }],
      },
      explain: { stages: [] },
      returnedMemories: [],
    });

    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(second.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
    const after = await stores.memoryStore.get(ctx, memory.id);
    expect({ tags: after?.tags, attributes: after?.attributes, claimKey: after?.claimKey }).toEqual(
      { tags: [], attributes: {}, claimKey: null },
    );
    const band = (await stores.memoryStore.getRecall(ctx, recallId))?.indexBand.digestBand;
    expect(band).toEqual([{ memoryId: memory.id, digest: after!.digest }]);
    expect(after!.digest).not.toBe("秘密の要旨");
  });
});

describe("runtime.purge — MemoryStore.purgeMemory が無い adapter（任意メソッド）", () => {
  it("purgeMemory が無ければ supported: false・全対象が not_attempted・書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    disablePurgeMemory(stores);
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result).toEqual({
      supported: false,
      outcomes: [{ memoryId: memory.id, kind: "not_attempted" }],
    });
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("purgeMemory が無ければ dryRun でも supported: false・not_attempted になる（下見も含めて一様に『対応していない』）", async () => {
    const { runtime, stores } = buildRuntime();
    disablePurgeMemory(stores);
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result).toEqual({
      supported: false,
      outcomes: [{ memoryId: memory.id, kind: "not_attempted" }],
    });
  });

  it("複数対象・空配列でも supported は一様に false", async () => {
    const { runtime, stores } = buildRuntime();
    disablePurgeMemory(stores);

    const empty = await runtime.purge(ctx, { memoryIds: [] });
    expect(empty).toEqual({ supported: false, outcomes: [] });
  });
});

describe("runtime.purge — 並行（purgeMemory が MemoryPurgeConflictError を投げる）", () => {
  it("再読すると既に purge 済み（別の呼び出しが先に purge していた）⟹ already_purged", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
        live.purgedAt = new Date();
        live.content = "[purged]";
        live.digest = "[purged]";
      }
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読すると既に purge 済み⟹ already_purged でも embedding をベストエフォートで消す（Issue #1425、ADR 0382）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
        live.purgedAt = new Date();
        live.content = "[purged]";
        live.digest = "[purged]";
      }
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
    expect(stores.vectorStore.entries.size).toBe(0);
  });

  it("再読すると status が forgotten でなくなっていた⟹ status_not_forgotten", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        stores.memoryStore.liveRowForTest(ctx, memory.id)!.status = "active";
      }
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "status_not_forgotten", status: "active" },
    ]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読すると行が消えていた（get が null を返す）⟹ not_found・再試行ループにしない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        stores.memoryStore.liveRowForTest(ctx, memory.id)!.status = "active";
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

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "not_found" }]);
    expect(getCalls).toBe(2); // 1回だけ再読した（上限の無いループになっていない）
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });
});

describe("runtime.purge — 打ち切り（競合でない例外）", () => {
  it("2件目で普通の Error が投げられたら [purged, failed, not_attempted]・例外は伝播せず・3件目は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const originalPurgeMemory = stores.memoryStore.purgeMemory!.bind(stores.memoryStore);
    stores.memoryStore.purgeMemory = async (c, id, tombstone, event) => {
      if (id === m2.id) {
        throw new Error("simulated connection reset");
      }
      return originalPurgeMemory(c, id, tombstone, event);
    };

    const result = await runtime.purge(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result.outcomes).toEqual([
      { memoryId: m1.id, kind: "purged", previousStatus: "forgotten" },
      { memoryId: m2.id, kind: "failed", error: "simulated connection reset" },
      { memoryId: m3.id, kind: "not_attempted" },
    ]);

    const m3After = await stores.memoryStore.get(ctx, m3.id);
    expect(m3After?.status).toBe("forgotten");
    expect(m3After?.purgedAt ?? null).toBeNull(); // 3件目には一切触れていない
  });
});

describe("runtime.purge — tick()/observe() から呼ばれない", () => {
  it("tick() を呼んでも purge 対象の Memory は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const tickResult = await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(tickResult.unsupported).toEqual([]);
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.purgedAt ?? null).toBeNull();
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });

  it("observe({ kind: 'memory_usage' }) を呼んでも purge 対象の Memory は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", embeddingStatus: "ready" }),
    );
    const recallId = await stores.memoryStore.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [
        {
          memoryId: memory.id,
          score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 1 },
          retrievedVia: "ann",
        },
      ],
    });

    await runtime.observe(ctx, { kind: "memory_usage", recallId, usedMemoryIds: [memory.id] });

    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.purgedAt ?? null).toBeNull();
    expect(stored?.content).toBe("本文");
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });
});

describe("runtime.purge — recall()/aggregateScope への影響（ADR 0124 決定6）", () => {
  /**
   * purge は `status` を動かさないため、purge された Memory は purge の前後を通じて常に `status = 'forgotten'` であり、
   * そもそも一度も「スコープ内」に入ったことが無い。この歯はそれを主張ではなく実測で示す。
   */
  it("forget → purge の前後で recall() の結果も index.totalInScope/groups も変わらない", async () => {
    const { runtime, stores } = buildRuntime();
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, forgotten.id, [1, 0]);
    const other = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, other.id, [0, 1]);

    await runtime.forget(ctx, { memoryId: forgotten.id });

    const beforePurge = await runtime.recall(ctx, { vector: [1, 0] });
    expect(beforePurge.memories.map((m) => m.memoryId)).not.toContain(forgotten.id);
    expect(beforePurge.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      scopeRelation: "outside_scope",
      count: 1,
      countKind: "exact",
    });
    const totalInScopeBefore = beforePurge.index.totalInScope;
    const groupsBefore = beforePurge.index.groups;

    const purgeResult = await runtime.purge(ctx, { memoryId: forgotten.id });
    expect(purgeResult.outcomes).toEqual([
      { memoryId: forgotten.id, kind: "purged", previousStatus: "forgotten" },
    ]);

    const afterPurge = await runtime.recall(ctx, { vector: [1, 0] });
    expect(afterPurge.memories.map((m) => m.memoryId)).not.toContain(forgotten.id);
    expect(afterPurge.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      scopeRelation: "outside_scope",
      count: 1,
      countKind: "exact",
    });
    expect(afterPurge.index.totalInScope).toBe(totalInScopeBefore);
    expect(afterPurge.index.groups).toEqual(groupsBefore);
  });
});

describe("runtime.purge — CAS が破れた後の再読そのものが失敗する", () => {
  /** `forget.test.ts` の同名の describe と同じ理由（例外はこのメソッドの外へは投げない）。1件目の purge は不可逆なので、例外で呼び出し側から見えなくなると最も困る。 */
  it("2件目の再読で get が投げても [purged, failed, not_attempted]・例外は伝播しない", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === m2.id) {
        stores.memoryStore.liveRowForTest(ctx, m2.id)!.status = "archived"; // ADR 0562: 返り値は写し
      }
    };
    // m2 への get の1回目は purgeMemory 内部（CAS 判定用）、2回目が再読。
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

    const result = await runtime.purge(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result).toEqual({
      supported: true,
      outcomes: [
        { memoryId: m1.id, kind: "purged", previousStatus: "forgotten" },
        { memoryId: m2.id, kind: "failed", error: "simulated connection reset on refetch" },
        { memoryId: m3.id, kind: "not_attempted" },
      ],
    });
    expect(purgedEvents(stores, m1.id)).toHaveLength(1);
    expect(purgedEvents(stores, m2.id)).toHaveLength(0);
    const m3After = await originalGet(ctx, m3.id);
    expect(m3After?.purgedAt ?? null).toBeNull(); // 3件目には一切触れていない
  });
});

describe("runtime.purge — ループ前の一括読み（getMany）が失敗する（Issue #964）", () => {
  /** `forget.test.ts` の同名の describe と同じ理由。 */
  it("getMany が投げても [failed, not_attempted, not_attempted]・例外は伝播せず・書き込み0件", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.getMany = async () => {
      throw new Error("simulated connection reset on getMany");
    };

    const result = await runtime.purge(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result).toEqual({
      supported: true,
      outcomes: [
        { memoryId: m1.id, kind: "failed", error: "simulated connection reset on getMany" },
        { memoryId: m2.id, kind: "not_attempted" },
        { memoryId: m3.id, kind: "not_attempted" },
      ],
    });
    expect(stores.eventStore.events.filter((e) => e.kind === "purged")).toHaveLength(0);
  });
});

/**
 * `runtime.purge` は `memoryStore.purgeMemory` をそのまま呼ぶだけで、広げた範囲（`tags`/`attributes`/`claimKey`・label の紐付け・
 * `recalls.index_band`）はすべて `MemoryStore.purgeMemory` 側の契約。ここでは `FakeMemoryStore` が
 * `@mnemora/postgres`/`@mnemora/testkit` と同じ範囲を実装していることを、`Runtime.purge` 経由で end-to-end に確かめる。
 */
describe("runtime.purge — ADR 0375: 広げた範囲（tags・attributes・claim key・labels・recalls の目次帯）", () => {
  it("purge は tags・attributes・claim key を空にする", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        status: "forgotten",
        tags: ["secret-tag"],
        attributes: { owner: "alice" },
        claimKey: { subject: "user", predicate: "home_city" },
      }),
    );

    await runtime.purge(ctx, { memoryId: memory.id });

    const after = await stores.memoryStore.get(ctx, memory.id);
    expect(after?.tags).toEqual([]);
    expect(after?.attributes).toEqual({});
    expect(after?.claimKey ?? null).toBeNull();
  });

  it("purge は label の紐付けを外し、proposed な label の proposedCount を減らす（他の Memory が同じ label を使い続けていれば、その分は残る）", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", tags: ["shared-tag"] }),
    );
    await stores.memoryStore.createMemory(ctx, newMemory({ tags: ["shared-tag"] }));
    expect(
      (await stores.memoryStore.listLabels!(ctx)).find((l) => l.name === "shared-tag")
        ?.proposedCount,
    ).toBe(2);

    await runtime.purge(ctx, { memoryId: target.id });

    expect(
      (await stores.memoryStore.listLabels!(ctx)).find((l) => l.name === "shared-tag"),
    ).toEqual({ name: "shared-tag", status: "proposed", proposedCount: 1, registeredAt: null });
  });

  it("purge はこのテナントの recalls.index_band の digestBand から、この memoryId の digest を伏せる（Issue #994 の再現）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", digest: "SECRET-DIGEST" }),
    );
    const usage = {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic" as const,
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    };
    const recallId = await stores.memoryStore.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "q" },
      budget: null,
      omitted: [],
      usage,
      indexBand: {
        groups: [],
        totalInScope: 1,
        countKind: "exact",
        digestBand: [{ memoryId: memory.id, digest: memory.digest }],
      },
      explain: { stages: [] },
      returnedMemories: [],
    });

    await runtime.purge(ctx, { memoryId: memory.id });

    const record = await stores.memoryStore.getRecall(ctx, recallId);
    expect(record?.indexBand.digestBand).toEqual([{ memoryId: memory.id, digest: "[purged]" }]);
  });
});

describe("runtime.purge — embedding を消すのは purge の対象にした記憶だけである", () => {
  function embeddedMemoryIds(stores: ReturnType<typeof createFakeRuntimeStores>): MemoryId[] {
    return [...stores.vectorStore.entries.values()].map((entry) => entry.memoryId).sort();
  }

  async function createEmbedded(
    stores: ReturnType<typeof createFakeRuntimeStores>,
    overrides: Partial<NewMemory>,
  ) {
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ embeddingStatus: "ready", ...overrides }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    return memory;
  }

  it("同じ呼び出しに forgotten でない記憶が混ざっていても、その embedding は残る", async () => {
    const { runtime, stores } = buildRuntime();
    const forgotten = await createEmbedded(stores, { status: "forgotten" });
    const active = await createEmbedded(stores, { status: "active" });
    const archived = await createEmbedded(stores, { status: "archived" });

    const result = await runtime.purge(ctx, {
      memoryIds: [forgotten.id, active.id, archived.id],
    });

    expect(result.outcomes.map((o) => o.kind)).toEqual([
      "purged",
      "status_not_forgotten",
      "status_not_forgotten",
    ]);
    expect(embeddedMemoryIds(stores)).toEqual([active.id, archived.id].sort());
  });

  it("purge 済みの記憶を再実行しても、同じ呼び出しの他の記憶の embedding には触れない", async () => {
    const { runtime, stores } = buildRuntime();
    const alreadyPurged = await createEmbedded(stores, { status: "forgotten" });
    await runtime.purge(ctx, { memoryId: alreadyPurged.id });
    // purge 後に旧 space から残った行を模す。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, alreadyPurged.id, [1, 0]);
    const active = await createEmbedded(stores, { status: "active" });

    const result = await runtime.purge(ctx, { memoryIds: [alreadyPurged.id, active.id] });

    expect(result.outcomes.map((o) => o.kind)).toEqual(["already_purged", "status_not_forgotten"]);
    expect(embeddedMemoryIds(stores)).toEqual([active.id]);
  });
});

describe("runtime.purge — イベントの at は注入された時計の now である", () => {
  it("記憶の recordedAt が now と違っても、purged イベントの at は now になる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", recordedAt: new Date(NOW.getTime() - 86_400_000) }),
    );

    await runtime.purge(ctx, { memoryId: memory.id });

    expect(purgedEvents(stores, memory.id).map((e) => e.at)).toEqual([NOW]);
  });
});
