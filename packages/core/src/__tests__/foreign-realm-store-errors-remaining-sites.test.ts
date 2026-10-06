import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { classifySupersedeFailure } from "../strategies/reextract.js";
import {
  FOREIGN_VARIANTS,
  foreignError,
  foreignMemoryStatusConflict,
  foreignOutboxLeaseConflict,
} from "./foreign-realm-errors.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の #1509 のすり抜け R1・R3・I2〜I5（ADR 0418）。
 * `foreign-realm-store-errors.test.ts`（PR の歯）は `tick` の complete 経路と `restoreArchived` の2か所だけを、
 * 別の realm の store 例外（`vm` で定義し直したクラス。本物のクラスの `instanceof` では false）で見ていた。
 * ここでは、報告で「判定を `instanceof` に戻す／常に偽にする」と緑のままだった6か所を、同じ形で縛る。
 *
 * - R1: `tick` の、処理できない kind のジョブの `fail()` がリース競合になった枝
 * - R3: `tick` の、ハンドラ失敗後の `fail()` がリース競合になった枝
 * - I2: `purge` の `MemoryPurgeConflictError`
 * - I3: `resolveContestedGroup` の `ContestedGroupMembershipMismatchError`
 * - I4: `reextract` の `SourceMemoryForgottenError`（口ありの経路と、口なしのループの両方）
 * - I5: `classifySupersedeFailure` の `MemoryStatusConflictError`
 */
const ctx: Ctx = { tenantId: "tenant-foreign-remaining" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const CUSTOM_KIND = "custom:foreign-realm-probe";

let contents: string[] = [];
const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" as const })),
    }),
};

function buildKit() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    relationStore: stores.relationStore,
    clock: { now: () => new Date(Date.now() + 60_000) },
  });
  return { runtime, stores };
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
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
    ...overrides,
  };
}

describe.each(FOREIGN_VARIANTS)("別の realm の store 例外（残りの判定箇所）— $label", (variant) => {
  it("R1 tick: 処理できない kind のジョブの fail() が別の realm のリース競合で弾かれても、tick は reject されず leaseConflicts に積まれる", async () => {
    const { runtime, stores } = buildKit();
    await stores.memoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: ctx.tenantId, subjectId: null, externalId: null, kind: "utterance", payload: {} },
      [CUSTOM_KIND],
    );
    stores.outboxStore.fail = async (_c, jobId, _error, expected) => {
      throw foreignOutboxLeaseConflict(jobId, expected, expected + 1, variant);
    };

    const result = await runtime.tick(ctx, { kinds: [CUSTOM_KIND], leaseMs: 60_000 });

    expect(result.unsupported).toEqual([]);
    expect(result.failed).toBe(0);
    expect(result.leaseConflicts).toHaveLength(1);
    expect(result.leaseConflicts[0]).toMatchObject({ kind: CUSTOM_KIND, attemptedOutcome: "fail" });
  });

  it("R3 tick: ハンドラが失敗し、その後の fail() が別の realm のリース競合で弾かれても、tick は reject されず後続は処理される", async () => {
    const { runtime, stores } = buildKit();
    contents = ["本文"];
    const a = await runtime.observe(ctx, { kind: "utterance", text: "本文A" });
    const b = await runtime.observe(ctx, { kind: "utterance", text: "本文B" });
    // 1件目の embed ジョブだけ provider が落ちる（ハンドラ失敗）。
    let embedCalls = 0;
    const realEmbed = stores.embeddingProvider.embed.bind(stores.embeddingProvider);
    stores.embeddingProvider.embed = async (c, texts, opts) => {
      embedCalls += 1;
      if (embedCalls === 1) throw new Error("provider down");
      return realEmbed(c, texts, opts);
    };
    let failedJobId: string | null = null;
    stores.outboxStore.fail = async (c, jobId, error, expected, opts) => {
      failedJobId ??= jobId;
      throw foreignOutboxLeaseConflict(jobId, expected, expected + 1, variant);
    };

    const result = await runtime.tick(ctx, { kinds: ["embed"], limit: 10, leaseMs: 60_000 });

    expect(result.failed).toBe(0);
    expect(result.processed).toBe(1);
    expect(result.leaseConflicts).toHaveLength(1);
    expect(result.leaseConflicts[0]).toMatchObject({
      jobId: failedJobId,
      kind: "embed",
      attemptedOutcome: "fail",
    });
    // 後続のジョブ（2件目）は、競合と無関係にいつもどおり処理されている。
    const statuses = [
      (await stores.memoryStore.get(ctx, a.memoryIds[0]!))?.embeddingStatus,
      (await stores.memoryStore.get(ctx, b.memoryIds[0]!))?.embeddingStatus,
    ];
    expect(statuses.filter((s) => s === "ready")).toHaveLength(1);
  });

  it("I2 purge: purgeMemory が別の realm の MemoryPurgeConflictError を投げても、再読の分類（already_purged）になり failed にならない", async () => {
    const { runtime, stores } = buildKit();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    // 別のワーカーが先に purge していた、という状況。store は別の realm の例外で競合を知らせる。
    stores.memoryStore.purgeMemory = async (_c, id) => {
      const live = stores.memoryStore.liveRowForTest(ctx, id)!;
      live.purgedAt = new Date();
      live.content = "[purged]";
      live.digest = "[purged]";
      throw foreignError(
        "MemoryPurgeConflictError",
        { memoryId: id, observedStatus: "forgotten", observedPurgedAt: live.purgedAt },
        variant,
      );
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toMatchObject([{ memoryId: memory.id, kind: "already_purged" }]);
  });

  it("I3 resolveContestedGroup: store が別の realm の ContestedGroupMembershipMismatchError を投げたら ineligible（missingMembers 付き）になる", async () => {
    const { runtime, stores } = buildKit();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    stores.memoryStore.resolveContestedGroup = async () => {
      throw foreignError(
        "ContestedGroupMembershipMismatchError",
        { missingMemberId: c.id },
        variant,
      );
    };

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "both_active",
    });

    expect(result.supported).toBe(true);
    expect(result.outcome).toMatchObject({ kind: "ineligible", missingMembers: [c.id] });
  });

  it("I4 reextract（口あり）: supersedeWithNewMemories が別の realm の SourceMemoryForgottenError を投げたら、例外にならず打ち切りの戻り値になる", async () => {
    const { runtime, stores } = buildKit();
    contents = ["猫は3匹"];
    const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
    const existing = first.memoryIds[0]!;
    stores.memoryStore.supersedeWithNewMemories = async () => {
      throw foreignError(
        "SourceMemoryForgottenError",
        { method: "supersedeWithNewMemories", forgottenIds: [existing] },
        variant,
      );
    };

    contents = ["猫を3匹飼っている"];
    const result = await runtime.reextract(ctx, first.observationId);

    expect(result).toMatchObject({
      memoryIds: [],
      supersededMemoryIds: [],
      atomicity: "not_attempted",
      extraction: "skipped",
    });
    expect(result.skipped).toEqual([
      { kind: "status_not_active", memoryId: existing, status: "forgotten" },
    ]);
  });

  it("I4 reextract（口なしのループ）: createMemoryWithOutbox が別の realm の SourceMemoryForgottenError を投げても、同じく打ち切りの戻り値になる", async () => {
    const { runtime, stores } = buildKit();
    contents = ["猫は3匹"];
    const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
    const existing = first.memoryIds[0]!;
    Object.defineProperty(stores.memoryStore, "supersedeWithNewMemories", {
      value: undefined,
      configurable: true,
    });
    stores.memoryStore.createMemoryWithOutbox = async () => {
      throw foreignError(
        "SourceMemoryForgottenError",
        { method: "createMemoryWithOutbox", forgottenIds: [existing] },
        variant,
      );
    };

    contents = ["猫を3匹飼っている"];
    const result = await runtime.reextract(ctx, first.observationId);

    expect(result).toMatchObject({
      memoryIds: [],
      atomicity: "not_attempted",
      extraction: "skipped",
    });
    expect(result.skipped).toEqual([
      { kind: "status_not_active", memoryId: existing, status: "forgotten" },
    ]);
  });

  it("I5 classifySupersedeFailure: 別の realm の MemoryStatusConflictError も status_changed_concurrently に仕分ける", () => {
    const error = foreignMemoryStatusConflict("mem-1", "active", "forgotten", variant);
    expect(classifySupersedeFailure("mem-1", error)).toEqual({
      kind: "status_changed_concurrently",
      memoryId: "mem-1",
      observedStatus: "forgotten",
    });
  });

  it("I5 の対照: ただの Error は仕分けない（null）", () => {
    expect(classifySupersedeFailure("mem-1", new Error("connection reset"))).toBeNull();
  });
});
