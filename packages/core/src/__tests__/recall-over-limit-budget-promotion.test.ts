import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #940（ADR 0203 追記3）。
 *
 * PR #922（Issue #823）と PR #930（Issue #925）は、`over_limit(stage:"rescore")` に
 * 数えた候補が段3（必須の同伴取得、`companions`）または段3.5（連想、`associationUnits`）
 * を経由して**候補集合に戻った**ときの取り下げを実装したが、どちらも条件に
 * `returnedMemoryIds.has(...)`（段4の**後**の最終集合、`finalMemories`）を AND で
 * 課していた——候補が戻った後、段4の予算切り詰めで改めて落ちるケースを見ていなかった。
 * この場合、取り下げが起きず、同じ1件が `over_limit(stage:"rescore")` と
 * `budget_dropped` の両方に数えられる（Issue #940 本文の再現そのもの）。
 *
 * 本ファイルは、この二重計上が段3経由（(a)）・段3.5経由（(b)）のどちらでも実際に起きる
 * ことを固定し、修正後は「最後にその候補を落とした段（ここでは段4の budget）で1回だけ
 * 数える」（ADR 0203 追記3が決めたこと）ことを確認する。(c) は、同伴取得/連想を一度も
 * 経由していない over_limit のバイスタンダーまで差し引いてしまう過剰実装を捕まえる歯。
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

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — 段3/段3.5で戻った over_limit(stage:'rescore') の候補が段4の予算で改めて落ちたときの排他性（Issue #940）", () => {
  it("(a) 段3（必須の同伴取得）で戻った候補が段4の予算で落ちると、over_limit(rescore) は消え budget_dropped だけに数えられる", async () => {
    const { runtime, stores } = buildRuntime();

    // cand1: クエリと完全一致。limit=2 の1枠を占め、予算にちょうど収まる唯一の候補。
    const cand1 = await createEmbeddedMemory(stores, [1, 0], { digest: "C" });
    // companion: owner の対向。owner にさらに劣り、limit=2 の外——段2で
    // over_limit(stage:"rescore") に落ちるが、段3の必須同伴取得で owner の対向として
    // 候補集合に戻る。`contestedWithId` は owner 側からだけ辿られる（ADR 0136）ので、
    // companion 自身には設定しない。
    const companion = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      status: "contested",
      digest: "COMPANION",
    });
    // owner: cand1 にわずかに劣るが、limit=2 のもう1枠を占める。companion と contested。
    const owner = await createEmbeddedMemory(stores, [0.999, 0.0447], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "OWNER",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 2,
      overFetchFactor: 10,
      // 段3.5（連想、既定 on）を明示的に切る——本テストが検査したいのは段3と段4だけ。
      association: null,
      // cand1 の digest（1文字）しか収まらない予算。owner+companion の単位（隣接性の
      // 不変条件で分割できない、docs/recall.md §8）は丸ごと budget_dropped になる。
      budget: { maxMemoryChars: cand1.digest.length },
    });

    // memories は cand1 だけ——owner・companion はどちらも予算切り詰めで落ちる。
    expect(result.memories.map((m) => m.memoryId)).toEqual([cand1.id]);
    expect(result.memories.some((m) => m.memoryId === owner.id)).toBe(false);
    expect(result.memories.some((m) => m.memoryId === companion.id)).toBe(false);

    // 修正後の期待: over_limit(stage:"rescore") は companion 分がまるごと budget_dropped
    // 側へ差し引かれ、Omission 自体が配列から消える。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();

    // owner + companion の2件が budget_dropped として数えられる。
    const budgetDropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(budgetDropped).toBeDefined();
    if (budgetDropped?.kind === "budget_dropped") {
      expect(budgetDropped.count).toBe(2);
    }
  });

  it("(b) 段3.5（連想）で戻った候補が段4の予算で落ちると、over_limit(rescore) は消え budget_dropped だけに数えられる", async () => {
    const { runtime, stores } = buildRuntime();

    // cand1: クエリと完全一致。limit=2 の1枠を占める。
    const cand1 = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "C" });
    // owner: cand1 にわずかに劣るが limit=2 のもう1枠を占め、連想のアンカーになる。
    const owner = await createEmbeddedMemory(stores, [0.999, 0.0447, 0], { digest: "OWNER" });
    // b: owner にさらに劣り、limit=2 の外——段2で over_limit(stage:"rescore") に落ちるが、
    // owner への類似度が連想の minSimilarity（既定 0.5）を軽々超えるため、段3.5 で
    // owner から拾い直され `retrievedVia: "association"` として候補集合に戻る。
    const b = await createEmbeddedMemory(stores, [0.99, 0.1411, 0], { digest: "B" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      overFetchFactor: 10,
      // association は渡さない——既定 on（ADR 0337）のまま呼ぶ。
      // cand1 + owner（ann、2件）の digest しか収まらない予算。連想枠は budget の
      // 内側に置かれ、末尾に連結されるので真っ先に落ちる（recall-runtime.ts の
      // 「段4」コメント参照）。
      budget: { maxMemoryChars: cand1.digest.length + owner.digest.length },
    });

    // memories は cand1 + owner だけ——b は連想で戻った後、予算切り詰めで落ちる。
    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([cand1.id, owner.id].sort());
    expect(result.memories.some((m) => m.memoryId === b.id)).toBe(false);

    // 修正後の期待: over_limit(stage:"rescore") は b の分がまるごと budget_dropped 側へ
    // 差し引かれ、Omission 自体が配列から消える。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();

    const budgetDropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(budgetDropped).toBeDefined();
    if (budgetDropped?.kind === "budget_dropped") {
      expect(budgetDropped.count).toBe(1);
    }
  });

  it("(c) 同伴取得/連想を経由していない over_limit のバイスタンダーが居るときは、その分の over_limit(rescore) が残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    // (a) と同じ contested ペア構成。
    const cand1 = await createEmbeddedMemory(stores, [1, 0], { digest: "C" });
    const companion = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      status: "contested",
      digest: "COMPANION",
    });
    const owner = await createEmbeddedMemory(stores, [0.999, 0.0447], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "OWNER",
    });
    // bystander: 誰の同伴でも連想候補でもない。閾値は通るが limit=2 の外——
    // over_limit(stage:"rescore") にちょうど1件、companion とは無関係に計上される。
    // 予算にもそもそも候補として乗らない（over_limit の候補は allUnits を構成しない）。
    const bystander = await createEmbeddedMemory(stores, [0.9, 0.436], {
      digest: "BYSTANDER",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 2,
      overFetchFactor: 10,
      association: null,
      budget: { maxMemoryChars: cand1.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([cand1.id]);
    expect(result.memories.some((m) => m.memoryId === owner.id)).toBe(false);
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();

    // over_limit(stage:"rescore") は companion + bystander の2件で始まる。companion は
    // 段3で戻って段4で落ちるので差し引かれるが、bystander は同伴取得にも連想にも
    // 一度も触れていない——「overLimit 全件を差し引く」ような過剰実装だと、ここが
    // 誤って 0（Omission 自体が消える）になる。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }

    const budgetDropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(budgetDropped).toBeDefined();
    if (budgetDropped?.kind === "budget_dropped") {
      expect(budgetDropped.count).toBe(2);
    }
  });
});
