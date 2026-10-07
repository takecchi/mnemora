import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryId } from "../ids.js";
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

/** `consolidate.test.ts` の `llmConsolidatingTo` と同じ形。統合結果を固定で返す決定的な偽物。 */
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

function buildRuntime(llmProvider: LLMProvider = notUsedLlm) {
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
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

/** `mark-contested.test.ts` の `disableMarkContestedPair` と同じ形。 */
function disableRestoreSupersededBy(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "restoreSupersededBy", {
    value: undefined,
    configurable: true,
  });
}

function unsupersededEvents(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  memoryId: MemoryId,
) {
  return stores.eventStore.events.filter(
    (e) => e.memoryId === memoryId && e.kind === "unsuperseded",
  );
}

describe("runtime.restoreSuperseded — 往復（consolidate → superseded → recall に出ない → restoreSuperseded → recall に出る）", () => {
  it("consolidate で superseded になった統合元は restoreSuperseded で active に戻り、recall() に再び現れる。統合先は一切触られない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後の本文" }));
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

    const before = await runtime.recall(ctx, { vector: [1, 0] });
    expect(before.memories.map((m) => m.memoryId)).toEqual(expect.arrayContaining([a.id, b.id]));

    const consolidateResult = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
    });
    expect(consolidateResult.outcome).toBe("consolidated");
    const consolidatedId = consolidateResult.consolidatedMemoryId!;
    expect(consolidatedId).not.toBeNull();

    const aAfterConsolidate = await stores.memoryStore.get(ctx, a.id);
    const bAfterConsolidate = await stores.memoryStore.get(ctx, b.id);
    expect(aAfterConsolidate?.status).toBe("superseded");
    expect(aAfterConsolidate?.supersededById).toBe(consolidatedId);
    expect(bAfterConsolidate?.status).toBe("superseded");
    expect(bAfterConsolidate?.supersededById).toBe(consolidatedId);

    const duringSuperseded = await runtime.recall(ctx, { vector: [1, 0] });
    expect(duringSuperseded.memories.map((m) => m.memoryId)).not.toContain(a.id);
    expect(duringSuperseded.memories.map((m) => m.memoryId)).not.toContain(b.id);
    expect(duringSuperseded.omitted).toContainEqual({
      kind: "filtered",
      condition: "superseded",
      scopeRelation: "outside_scope",
      count: 2,
      countKind: "exact",
    });

    const restoreResult = await runtime.restoreSuperseded(ctx, { supersededById: consolidatedId });

    expect(restoreResult.supported).toBe(true);
    expect(restoreResult.supersedingMemoryId).toBe(consolidatedId);
    expect(restoreResult.outcomes).toHaveLength(2);
    expect(new Set(restoreResult.outcomes.map((o) => o.memoryId))).toEqual(new Set([a.id, b.id]));
    for (const outcome of restoreResult.outcomes) {
      expect(outcome.kind).toBe("restored");
      if (outcome.kind === "restored") {
        expect(outcome.previousStatus).toBe("superseded");
        expect(outcome.reinforceError).toBeUndefined();
      }
    }

    const aAfterRestore = await stores.memoryStore.get(ctx, a.id);
    const bAfterRestore = await stores.memoryStore.get(ctx, b.id);
    expect(aAfterRestore?.status).toBe("active");
    expect(aAfterRestore?.supersededById).toBeNull();
    expect(bAfterRestore?.status).toBe("active");
    expect(bAfterRestore?.supersededById).toBeNull();

    // recall() をもう一度呼んで、統合元が返ってくることを確かめる。これが復旧口が本当に復旧している証拠なので、status の確認で止めない。
    const after = await runtime.recall(ctx, { vector: [1, 0] });
    expect(after.memories.map((m) => m.memoryId)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(after.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "superseded" }),
    );

    expect(unsupersededEvents(stores, a.id)).toHaveLength(1);
    expect(unsupersededEvents(stores, b.id)).toHaveLength(1);
    const allUnsuperseded = stores.eventStore.events.filter((e) => e.kind === "unsuperseded");
    expect(allUnsuperseded).toHaveLength(2);

    const consolidatedAfter = await stores.memoryStore.get(ctx, consolidatedId);
    expect(consolidatedAfter?.status).toBe("active");
    expect(consolidatedAfter?.content).toBe("統合後の本文");
    expect(unsupersededEvents(stores, consolidatedId)).toHaveLength(0);
  });
});

describe("runtime.restoreSuperseded — supported: false（store が restoreSupersededBy を持たない）", () => {
  it("store から restoreSupersededBy を外すと supported:false・outcomes は空配列で、書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const consolidateResult = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
    });
    const consolidatedId = consolidateResult.consolidatedMemoryId!;

    // ここだけ「口が無い adapter」を模す。プロトタイプメソッドは `delete` では外れないため、
    // `Object.defineProperty` で `undefined` の own property を被せる。
    disableRestoreSupersededBy(stores);

    const result = await runtime.restoreSuperseded(ctx, { supersededById: consolidatedId });

    expect(result).toEqual({ supported: false, supersedingMemoryId: consolidatedId, outcomes: [] });
    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("superseded"); // 書き込みは一切起きていない
    expect(unsupersededEvents(stores, a.id)).toHaveLength(0);
  });
});

describe("runtime.restoreSuperseded — 対象0件", () => {
  it("supersededById に実在する Memory を渡しても、supersede された行が無ければ outcomes は空配列", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));

    const result = await runtime.restoreSuperseded(ctx, { supersededById: anchor.id });

    expect(result).toEqual({ supported: true, supersedingMemoryId: anchor.id, outcomes: [] });
  });

  it("supersededById に実在しない id を渡しても例外にせず outcomes は空配列", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.restoreSuperseded(ctx, { supersededById: "no-such-memory" });

    expect(result).toEqual({
      supported: true,
      supersedingMemoryId: "no-such-memory",
      outcomes: [],
    });
  });
});

describe("runtime.restoreSuperseded — status が archived/forgotten に進んだ行を巻き込まない", () => {
  it("superseded_by_id が一致していても、status が既に archived/forgotten の行は対象にしない", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const archived = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "archived-progeny", status: "superseded", supersededById: anchor.id }),
    );
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "forgotten-progeny", status: "superseded", supersededById: anchor.id }),
    );
    // `superseded_by_id` を残したまま status だけをさらに進める（`purge`/`sweepArchive` 等が起こしうる状態を模す）。
    await stores.memoryStore.updateStatus(ctx, archived.id, "archived");
    await stores.memoryStore.updateStatus(ctx, forgotten.id, "forgotten");

    const result = await runtime.restoreSuperseded(ctx, { supersededById: anchor.id });

    expect(result.outcomes).toEqual([]);
    const archivedAfter = await stores.memoryStore.get(ctx, archived.id);
    const forgottenAfter = await stores.memoryStore.get(ctx, forgotten.id);
    expect(archivedAfter?.status).toBe("archived");
    expect(archivedAfter?.supersededById).toBe(anchor.id); // 触られていない
    expect(forgottenAfter?.status).toBe("forgotten");
    expect(forgottenAfter?.supersededById).toBe(anchor.id); // 触られていない
    expect(unsupersededEvents(stores, archived.id)).toHaveLength(0);
    expect(unsupersededEvents(stores, forgotten.id)).toHaveLength(0);
  });
});

describe("runtime.restoreSuperseded — reason / actor", () => {
  it("reason を省略すると meta.reason は固定タグ 'unsuperseded'（restoreArchived とは違う規律）", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );

    await runtime.restoreSuperseded(ctx, { supersededById: anchor.id });

    const [event] = unsupersededEvents(stores, source.id);
    expect(event?.meta).toEqual({ reason: "unsuperseded", supersededById: anchor.id });
  });

  it("reason を渡すと meta.reason に入り、meta.supersededById は外した相手の id", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );

    await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { reason: "問い合わせで必要になった" },
    );

    const [event] = unsupersededEvents(stores, source.id);
    expect(event?.meta).toEqual({
      reason: "問い合わせで必要になった",
      supersededById: anchor.id,
    });
  });

  it("actor を渡すとイベントの actor がそれになり、省略時は { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );

    await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { actor: { type: "human", id: "user-42" } },
    );

    const [event] = unsupersededEvents(stores, source.id);
    expect(event?.actor).toEqual({ type: "human", id: "user-42" });
  });
});

describe("runtime.restoreSuperseded — opts.dryRun（Issue #515、方向3「戻す前に何が戻るかを返す」）", () => {
  it("dryRun: true は書き込みを一切起こさず、would_restore で候補と由来（meta.reason）を返す。直後の実行と集合が一致する", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後の本文" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const consolidateResult = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
    });
    expect(consolidateResult.outcome).toBe("consolidated");
    const consolidatedId = consolidateResult.consolidatedMemoryId!;

    const before = await stores.memoryStore.get(ctx, a.id);
    expect(before?.status).toBe("superseded"); // 前提: 実際に群ができている

    const preview = await runtime.restoreSuperseded(
      ctx,
      { supersededById: consolidatedId },
      { dryRun: true },
    );

    expect(preview.supported).toBe(true);
    expect(preview.supersedingMemoryId).toBe(consolidatedId);
    expect(preview.outcomes).toHaveLength(2);
    expect(new Set(preview.outcomes.map((o) => o.memoryId))).toEqual(new Set([a.id, b.id]));
    for (const outcome of preview.outcomes) {
      expect(outcome.kind).toBe("would_restore");
      if (outcome.kind === "would_restore") {
        expect(outcome.previousStatus).toBe("superseded");
        expect(outcome.supersededReason).toBe("consolidated");
      }
    }

    const aAfterPreview = await stores.memoryStore.get(ctx, a.id);
    const bAfterPreview = await stores.memoryStore.get(ctx, b.id);
    expect(aAfterPreview?.status).toBe("superseded");
    expect(aAfterPreview?.supersededById).toBe(consolidatedId);
    expect(bAfterPreview?.status).toBe("superseded");
    expect(bAfterPreview?.supersededById).toBe(consolidatedId);
    expect(unsupersededEvents(stores, a.id)).toHaveLength(0);
    expect(unsupersededEvents(stores, b.id)).toHaveLength(0);

    const real = await runtime.restoreSuperseded(ctx, { supersededById: consolidatedId });
    expect(real.supported).toBe(true);
    expect(new Set(real.outcomes.map((o) => o.memoryId))).toEqual(
      new Set(preview.outcomes.map((o) => o.memoryId)),
    );
    for (const outcome of real.outcomes) {
      expect(outcome.kind).toBe("restored");
    }
  });

  it("dryRun: true で対象0件なら supported: true・outcomes は空配列（書き込みは無いのでこれも例外にしない）", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));

    const preview = await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { dryRun: true },
    );

    expect(preview).toEqual({ supported: true, supersedingMemoryId: anchor.id, outcomes: [] });
  });

  it("由来が取れない（一致する superseded イベントが無い）ときは supersededReason: null——取れるふりをしない", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    // superseded なイベントを一切積まず、status だけ手で superseded にする。`updateStatusWithEvent` は使わない:
    // "kind: superseded" のイベントを意図的に0件のままにするため。
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );

    const preview = await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { dryRun: true },
    );

    expect(preview.outcomes).toHaveLength(1);
    expect(preview.outcomes[0]).toEqual({
      memoryId: source.id,
      kind: "would_restore",
      previousStatus: "superseded",
      supersededReason: null,
    });
  });

  it("resolveContested が積む superseded イベントの reason（'contested_resolved'）も由来としてそのまま読める", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );
    // resolveContested が実際に積む形と同じ meta（`reason: "contested_resolved"`）を、直接1件積む。
    await stores.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: source.id,
      kind: "superseded",
      actor: { type: "system" },
      digestSnapshot: source.digest,
      meta: { reason: "contested_resolved", resolution: "supersede", supersededById: anchor.id },
    });

    const preview = await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { dryRun: true },
    );

    expect(preview.outcomes).toHaveLength(1);
    expect(preview.outcomes[0]).toMatchObject({
      memoryId: source.id,
      kind: "would_restore",
      supersededReason: "contested_resolved",
    });
  });

  it("dryRun: true は複数の superseded イベントがあっても直近（at が最大）の reason を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );
    await stores.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: source.id,
      kind: "superseded",
      at: new Date("2026-01-01T00:00:00.000Z"),
      actor: { type: "system" },
      digestSnapshot: source.digest,
      meta: { reason: "reextract_superseded" },
    });
    await stores.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: source.id,
      kind: "superseded",
      at: new Date("2026-06-01T00:00:00.000Z"),
      actor: { type: "system" },
      digestSnapshot: source.digest,
      meta: { reason: "consolidated" },
    });

    const preview = await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { dryRun: true },
    );

    expect(preview.outcomes).toHaveLength(1);
    expect(preview.outcomes[0]).toMatchObject({ supersededReason: "consolidated" });
  });

  it("dryRun: true で store が previewRestoreSupersededBy を持たなければ supported: false・outcomes は空配列で、書き込みは一切起きない（restoreSupersededBy の有無とは独立）", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const consolidateResult = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
    });
    const consolidatedId = consolidateResult.consolidatedMemoryId!;

    // `restoreSupersededBy` はそのまま残す。「dryRun の対応は独立した任意メソッドで決まる」ことを確かめたいので、こちらだけを外す。
    Object.defineProperty(stores.memoryStore, "previewRestoreSupersededBy", {
      value: undefined,
      configurable: true,
    });

    const preview = await runtime.restoreSuperseded(
      ctx,
      { supersededById: consolidatedId },
      { dryRun: true },
    );

    expect(preview).toEqual({
      supported: false,
      supersedingMemoryId: consolidatedId,
      outcomes: [],
    });
    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("superseded"); // 書き込みは一切起きていない
    expect(unsupersededEvents(stores, a.id)).toHaveLength(0);
  });

  it("opts.dryRun を省略・false にすると、この PR 以前と同じ『実際に戻す』既定のまま", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );

    const omittedResult = await runtime.restoreSuperseded(ctx, { supersededById: anchor.id });
    const sourceAfterOmitted = await stores.memoryStore.get(ctx, source.id);
    expect(omittedResult.outcomes[0]?.kind).toBe("restored");
    expect(sourceAfterOmitted?.status).toBe("active"); // 省略時は実際に戻っている

    const source2 = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source2", status: "superseded", supersededById: anchor.id }),
    );
    const explicitFalseResult = await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { dryRun: false },
    );
    const source2After = await stores.memoryStore.get(ctx, source2.id);
    expect(explicitFalseResult.outcomes[0]?.kind).toBe("restored");
    expect(source2After?.status).toBe("active");
  });
});

describe("runtime.restoreSuperseded — target.onlyMemoryIds（Issue #515 方向①、ADR 0258）", () => {
  it("onlyMemoryIds を指定すると、群のうちその id 集合だけが戻り、対象外は触られない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後の本文" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const consolidateResult = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
    });
    const consolidatedId = consolidateResult.consolidatedMemoryId!;

    const result = await runtime.restoreSuperseded(ctx, {
      supersededById: consolidatedId,
      onlyMemoryIds: [a.id],
    });

    expect(result.supported).toBe(true);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.memoryId).toBe(a.id);
    expect(result.outcomes[0]?.kind).toBe("restored");

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter?.status).toBe("active");
    expect(bAfter?.status).toBe("superseded"); // 対象外——触られていない
    expect(bAfter?.supersededById).toBe(consolidatedId);
    expect(unsupersededEvents(stores, a.id)).toHaveLength(1);
    expect(unsupersededEvents(stores, b.id)).toHaveLength(0);
  });

  it("onlyMemoryIds を省略すると、この機能を足す前と同じく群全体が対象になる（既定は1バイトも変えない）", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const consolidateResult = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
    });
    const consolidatedId = consolidateResult.consolidatedMemoryId!;

    const result = await runtime.restoreSuperseded(ctx, { supersededById: consolidatedId });

    expect(new Set(result.outcomes.map((o) => o.memoryId))).toEqual(new Set([a.id, b.id]));
  });

  it("onlyMemoryIds は dryRun: true と組み合わせても同じ積集合に絞る（previewRestoreSupersededBy へも素通しする）", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const consolidateResult = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
    });
    const consolidatedId = consolidateResult.consolidatedMemoryId!;

    const preview = await runtime.restoreSuperseded(
      ctx,
      { supersededById: consolidatedId, onlyMemoryIds: [b.id] },
      { dryRun: true },
    );

    expect(preview.outcomes).toHaveLength(1);
    expect(preview.outcomes[0]?.memoryId).toBe(b.id);
    expect(preview.outcomes[0]?.kind).toBe("would_restore");
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(bAfter?.status).toBe("superseded");
  });

  it("onlyMemoryIds に空配列を渡すと対象0件になる", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );

    const result = await runtime.restoreSuperseded(ctx, {
      supersededById: anchor.id,
      onlyMemoryIds: [],
    });

    expect(result).toEqual({ supported: true, supersedingMemoryId: anchor.id, outcomes: [] });
  });

  it("onlyMemoryIds に群に含まれない id を渡しても例外にせず、対象0件になる", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );
    const unrelated = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "unrelated" }),
    );

    const result = await runtime.restoreSuperseded(ctx, {
      supersededById: anchor.id,
      onlyMemoryIds: [unrelated.id],
    });

    expect(result).toEqual({ supported: true, supersedingMemoryId: anchor.id, outcomes: [] });
  });
});

describe("runtime.restoreSuperseded — reinforce が失敗しても status の復帰は握り潰さない（ADR 0153 と同じ規律）", () => {
  it("reinforce が例外を投げても outcome は 'restored' のままで、reinforceError にメッセージが入る。status は active のまま", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );

    const originalReinforce = stores.memoryStore.reinforce.bind(stores.memoryStore);
    stores.memoryStore.reinforce = async (c, id, at) => {
      if (id === source.id) {
        throw new Error("simulated reinforce failure");
      }
      return originalReinforce(c, id, at);
    };

    const result = await runtime.restoreSuperseded(ctx, { supersededById: anchor.id });

    expect(result.outcomes).toHaveLength(1);
    const [outcome] = result.outcomes;
    expect(outcome).toMatchObject({
      memoryId: source.id,
      kind: "restored",
      previousStatus: "superseded",
      reinforceError: "simulated reinforce failure",
    });

    const stored = await stores.memoryStore.get(ctx, source.id);
    expect(stored?.status).toBe("active");
    expect(stored?.supersededById).toBeNull();
  });
});
