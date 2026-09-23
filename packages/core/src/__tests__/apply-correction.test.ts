import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { buildCorrectionReason } from "../apply-correction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.applyCorrection`（北極星「目指す姿」項目5、Issue #369、
 * [ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)）の歯。
 *
 * **この歯が測っているもの**: `findCorrectionCandidates`（発見、ADR 0232）と
 * `markContested`/`resolveContested`（書き込み、ADR 0134/ADR 0150）の**間**——
 * これまで `examples/chat/src/correction-demo.ts` にしか無かった「選択」の段が、
 * `packages/core` の公開 API として実際に一巡すること。
 *
 * - 3態（`awaiting_choice`/`not_a_candidate`/`contested`|`resolved`）それぞれで、
 *   書き込みが起きた/起きなかったことを status と `memory_events` の件数で実測する。
 * - `resolution` を省くと `resolveContested` を一度も呼ばずに `contested` で止まる。
 * - ⭐ `resolveContested` まで進めたとき、敗者が `recall()` から実際に落ちる
 *   （北極星 項目5 の本体）。
 * - `markContested`/`resolveContested` の失敗（`ineligible`/`not_attempted`）を
 *   握り潰さずそのまま運ぶ。
 * - `tick()`/`observe()` からは呼ばれない。
 * - 監査理由（`buildCorrectionReason`）が `memory_events.meta.note` に載る。
 *
 * ⚠ **`correction-candidates.test.ts`/`mark-contested.test.ts`/`resolve-contested.test.ts`
 * が既に検査している範囲（`findCorrectionCandidates`/`markContested`/`resolveContested`
 * それぞれの単体の契約——CAS・`RangeError`・`not_attempted`・`conflict` の詳細な分岐等）は
 * ここでは繰り返さない。** ここで見るのは、それらを `applyCorrection` が正しく
 * orchestration しているか（呼ぶ・呼ばない・結果を運ぶ）だけである。
 *
 * `@mnemora/testkit` には依存しない（`mark-contested.test.ts` と同じ理由）。
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

/** `deps.memoryStore.markContestedPair` が無い adapter を模す（`mark-contested.test.ts` と同じ形）。 */
function disableMarkContestedPair(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "markContestedPair", {
    value: undefined,
    configurable: true,
  });
}

/**
 * `FakeEmbeddingProvider` は文字列長・'a' の数から決定的にベクトルを作る
 * （`correction-candidates.test.ts` と同じ約束事）。`"seed"` → `[4, 0]`。
 */
const QUERY_TEXT = "seed";

async function createCandidate(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
) {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("runtime.applyCorrection — awaiting_choice（correctedId 省略）", () => {
  it("correctedId が無ければ書き込みを1件もせずに awaiting_choice を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象" });
    const correcting = await createCandidate(stores, [1, 0], { digest: "訂正" });
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [correcting.id],
    });

    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctingId: correcting.id,
    });

    expect(result).toEqual({ kind: "awaiting_choice" });
    expect(stores.eventStore.events).toHaveLength(0);
    const stored = await stores.memoryStore.get(ctx, target.id);
    expect(stored?.status).toBe("active");
  });
});

describe("runtime.applyCorrection — not_a_candidate（指名が候補一覧に居ない）", () => {
  it("correctedId は渡されたが discovery.candidates に居なければ書き込みを1件もせずに not_a_candidate を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象" });
    const correcting = await createCandidate(stores, [1, 0], { digest: "訂正" });
    // target 自身も候補から除外する ⟹ discovery.candidates は空。
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [correcting.id, target.id],
    });
    expect(discovery.candidates).toHaveLength(0);

    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: correcting.id,
    });

    expect(result).toEqual({ kind: "not_a_candidate", correctedId: target.id });
    expect(stores.eventStore.events).toHaveLength(0);
    const stored = await stores.memoryStore.get(ctx, target.id);
    expect(stored?.status).toBe("active");
  });

  it("🔴🔴 候補一覧が空でなくても、指名(correctedId)がその中に無ければ候補外——discovery.candidates[0]を機械的に採る実装なら赤くなる", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "指名(候補外)" });
    const decoy = await createCandidate(stores, [8, 0.1], { digest: "候補1位(指名されていない)" });
    const correcting = await createCandidate(stores, [1, 0], { digest: "訂正" });
    // target は除外し、decoy は候補に残す ⟹ candidates は非空だが target は含まない。
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [correcting.id, target.id],
    });
    expect(discovery.candidates.length).toBeGreaterThan(0);
    expect(discovery.candidates.map((c) => c.memoryId)).not.toContain(target.id);
    expect(discovery.candidates.map((c) => c.memoryId)).toContain(decoy.id);

    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: correcting.id,
    });

    expect(result).toEqual({ kind: "not_a_candidate", correctedId: target.id });
    // 🔴 本体: decoy(候補1位) にも target にも一切書き込みが起きない。
    expect(stores.eventStore.events).toHaveLength(0);
    const storedTarget = await stores.memoryStore.get(ctx, target.id);
    const storedDecoy = await stores.memoryStore.get(ctx, decoy.id);
    expect(storedTarget?.status).toBe("active");
    expect(storedDecoy?.status).toBe("active");
  });
});

describe("runtime.applyCorrection — resolution を省くと contested で止まる（resolveContested は一度も呼ばれない）", () => {
  it("markContested だけが起き、resolveContested 由来のイベントは1件も積まれない", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象" });
    const correcting = await createCandidate(stores, [1, 0], { digest: "訂正" });
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [correcting.id],
    });
    expect(discovery.candidates.map((c) => c.memoryId)).toContain(target.id);

    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: correcting.id,
      // resolution を渡さない。
    });

    expect(result.kind).toBe("contested");
    if (result.kind !== "contested") throw new Error("unreachable");
    expect(result.markResult.outcome.kind).toBe("contested");
    expect(result.chosenRecallRank).toBe(
      discovery.candidates.find((c) => c.memoryId === target.id)?.recallRank,
    );
    expect("resolveResult" in result).toBe(false);

    // 書き込みは markContested 分（両側 'updated', meta.reason='contested'）の2件だけ。
    expect(stores.eventStore.events).toHaveLength(2);
    expect(stores.eventStore.events.every((e) => e.meta.reason === "contested")).toBe(true);
    expect(stores.eventStore.events.some((e) => e.meta.reason === "contested_resolved")).toBe(
      false,
    );

    const storedTarget = await stores.memoryStore.get(ctx, target.id);
    const storedCorrecting = await stores.memoryStore.get(ctx, correcting.id);
    expect(storedTarget?.status).toBe("contested");
    expect(storedCorrecting?.status).toBe("contested");
  });
});

describe("runtime.applyCorrection — markContested/resolveContested の失敗を握り潰さない", () => {
  it("markContestedPair が無い adapter ⟹ markResult.outcome.kind='not_attempted' がそのまま届き、続く resolveContested は ineligible（書き込みは一切起きない）", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象" });
    const correcting = await createCandidate(stores, [1, 0], { digest: "訂正" });
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [correcting.id],
    });
    disableMarkContestedPair(stores);

    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: correcting.id,
      resolution: { kind: "supersede", winnerId: correcting.id },
    });

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    expect(result.markResult).toEqual({ supported: false, outcome: { kind: "not_attempted" } });
    // markContested が書けなかったので status は active のまま ⟹ resolveContested から見ると
    // 「contested でない」——ineligible になる。書き込みは一切起きない。
    expect(result.resolveResult.supported).toBe(true);
    expect(result.resolveResult.outcome.kind).toBe("ineligible");
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("correctingId が存在しない ⟹ markResult.outcome.kind='ineligible' がそのまま届く（書き込みは一切起きない）", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象" });
    const discovery = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });
    expect(discovery.candidates.map((c) => c.memoryId)).toContain(target.id);

    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: target.id,
      correctingId: "does-not-exist" as typeof target.id,
    });

    expect(result.kind).toBe("contested");
    if (result.kind !== "contested") throw new Error("unreachable");
    expect(result.markResult.outcome.kind).toBe("ineligible");
    expect(stores.eventStore.events).toHaveLength(0);
    const storedTarget = await stores.memoryStore.get(ctx, target.id);
    expect(storedTarget?.status).toBe("active");
  });
});

describe("runtime.applyCorrection — tick()/observe() から呼ばれない", () => {
  it("tick() を呼んでも active な Memory は contested にならない", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象" });

    await runtime.tick(ctx, { leaseMs: 60_000 });

    const stored = await stores.memoryStore.get(ctx, target.id);
    expect(stored?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("buildCorrectionReason — winner ラベル（pending/both_active/corrected/correcting）", () => {
  const discovery = {
    recallId: "recall-1",
    candidates: [
      {
        memoryId: "a",
        digest: "d",
        recallRank: 2,
        score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.9 },
        retrievedVia: "ann",
      },
    ],
    omitted: [],
    explain: { stages: [] },
    outcome: "candidates",
    recalledCount: 1,
    excludedCount: 0,
  } as unknown as Parameters<typeof buildCorrectionReason>[0]["discovery"];

  it("resolution が無ければ winner=pending", () => {
    const reason = buildCorrectionReason({
      discovery,
      chosenRecallRank: 2,
      correctedId: "a" as never,
      correctingId: "b" as never,
      resolution: null,
    });
    expect(reason).toBe("chosenRecallRank=2 / candidates=1 / recallId=recall-1 / winner=pending");
  });

  it("both_active なら winner=both_active", () => {
    const reason = buildCorrectionReason({
      discovery,
      chosenRecallRank: 2,
      correctedId: "a" as never,
      correctingId: "b" as never,
      resolution: { kind: "both_active" },
    });
    expect(reason).toContain("winner=both_active");
  });

  it("supersede で winnerId===correctingId なら winner=correcting", () => {
    const reason = buildCorrectionReason({
      discovery,
      chosenRecallRank: 2,
      correctedId: "a" as never,
      correctingId: "b" as never,
      resolution: { kind: "supersede", winnerId: "b" as never },
    });
    expect(reason).toContain("winner=correcting");
  });

  it("supersede で winnerId===correctedId なら winner=corrected", () => {
    const reason = buildCorrectionReason({
      discovery,
      chosenRecallRank: 2,
      correctedId: "a" as never,
      correctingId: "b" as never,
      resolution: { kind: "supersede", winnerId: "a" as never },
    });
    expect(reason).toContain("winner=corrected");
  });

  it("score.total は載せない(ADR 0238)", () => {
    const reason = buildCorrectionReason({
      discovery,
      chosenRecallRank: 2,
      correctedId: "a" as never,
      correctingId: "b" as never,
      resolution: { kind: "supersede", winnerId: "b" as never },
    });
    expect(reason).not.toContain("0.9");
  });
});

describe("runtime.applyCorrection — 発見→選択→markContested→resolveContested の一巡（北極星 項目5 の本体）", () => {
  it("敗者(corrected 側)は resolveContested 後、recall() から実際に落ちる。2回の applyCorrection 呼び出し(mark のみ→resolution 付き)を通しても、両方の書き込みに同じ監査理由が載る", async () => {
    const { runtime, stores } = buildRuntime();
    // strong/weak の配置は resolve-contested.test.ts の「検出から解決までの一巡」と同じ
    // ——query [1,0] に対して strong は完全一致、weak は直交。limit:1 で mandatory
    // companion を実際に発火させる。
    const strong = await createCandidate(stores, [1, 0], { digest: "強い方(訂正される側)" });
    const weak = await createCandidate(stores, [0, 1], { digest: "弱い方(訂正する側)" });

    // 【発見】書き込み・LLM 無し（ADR 0232 の契約、ここでは呼び出しの配線だけ確認する）。
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [weak.id],
    });
    expect(discovery.candidates.map((c) => c.memoryId)).toContain(strong.id);
    const candidate = discovery.candidates.find((c) => c.memoryId === strong.id)!;

    // 【選択】相手は strong（discovery.candidates[0] ではなく、テストが明示的に指名した
    // strong.id をそのまま渡している——「機械が選ぶ」経路はここに無い）。
    const reason = buildCorrectionReason({
      discovery,
      chosenRecallRank: candidate.recallRank,
      correctedId: strong.id,
      correctingId: weak.id,
      resolution: { kind: "supersede", winnerId: weak.id },
    });

    // 1回目: resolution を渡さない ⟹ markContested だけが起きて contested で止まる。
    const marked = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: strong.id,
      correctingId: weak.id,
      reason,
    });
    expect(marked.kind).toBe("contested");
    if (marked.kind !== "contested") throw new Error("unreachable");
    expect(marked.markResult.outcome.kind).toBe("contested");

    // markContested 直後: 両方出て、対向は mandatory_companion として隣接する
    // （`resolve-contested.test.ts` の一巡と同じ実測）。
    const afterMark = await runtime.recall(ctx, { vector: [1, 0], limit: 1 });
    const afterMarkIds = afterMark.memories.map((m) => m.memoryId);
    expect(afterMarkIds).toContain(strong.id);
    expect(afterMarkIds).toContain(weak.id);
    const companion = afterMark.memories.find((m) => m.memoryId === weak.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
    expect(companion?.companionOf).toBe(strong.id);

    // 2回目: resolution を渡す ⟹ markContested はもう一度呼ばれるが、対象は既に
    // contested なので ineligible（書き込み無し）。resolveContested だけが実際に進む。
    const resolved = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: strong.id,
      correctingId: weak.id,
      resolution: { kind: "supersede", winnerId: weak.id },
      reason,
    });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error("unreachable");
    expect(resolved.markResult.outcome.kind).toBe("ineligible");
    expect(resolved.resolveResult.outcome.kind).toBe("resolved");

    // ⭐ 北極星 項目5 の核心: 敗者(strong、corrected 側)は recall からもう出てこない。
    // ⚠ クエリベクトルは勝者(weak, [0,1])に合わせる——strong はもう superseded で
    // 候補にすら入らないため、mandatory companion に頼らずスコアだけで拾える必要がある。
    const afterResolve = await runtime.recall(ctx, { vector: [0, 1], limit: 1 });
    const afterResolveIds = afterResolve.memories.map((m) => m.memoryId);
    expect(afterResolveIds).toContain(weak.id);
    expect(afterResolveIds).not.toContain(strong.id);

    // 監査理由: 両方の書き込み（markContested 成功1回・resolveContested 成功1回 ⟹
    // 合計4件のイベント）に、同じ reason 文字列が載っている。
    const notes = stores.eventStore.events.map((e) => e.meta.note);
    expect(notes).toHaveLength(4);
    expect(notes.every((n) => n === reason)).toBe(true);
    expect(reason).toContain(`recallId=${discovery.recallId}`);
    expect(reason).toContain(`chosenRecallRank=${candidate.recallRank}`);
    expect(reason).toContain(`candidates=${discovery.candidates.length}`);
    expect(reason).toContain("winner=correcting");
  });
});
