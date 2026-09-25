import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import type { MemoryId } from "../ids.js";
import {
  createFakeRuntimeStores,
  withGetVectorsSpy,
  withoutGetVectors,
  withReversedGetVectorsOrder,
} from "./runtime-fakes.js";

/**
 * 連想枠（Issue #200、ADR 0151、docs/recall.md §9）の歯。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
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

function buildRuntime(
  overrideVectorStore?: (stores: ReturnType<typeof createFakeRuntimeStores>) => VectorStore,
) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: overrideVectorStore ? overrideVectorStore(stores) : stores.vectorStore,
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

describe("recall() — 連想枠（association、既定 off）", () => {
  it("association を渡さなければ、返り値の形は1バイトも変わらない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "アンカー" });

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    // stage_skipped(association) が積まれない——問われていないことは「無い」ではない。
    expect(
      result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "association"),
    ).toBe(false);
    // byTier に association キー自体が無い（既定 off の形の証明）。
    expect(Object.keys(result.usage.byTier).sort()).toEqual(["digest", "full", "index"]);
    expect(result.memories.every((m) => m.retrievedVia !== "association")).toBe(true);
  });

  it("VectorStore.getVectors が無ければ stage_skipped(vector_store_lacks_get_vectors) が立つ", async () => {
    const { runtime, stores } = buildRuntime((s) => withoutGetVectors(s.vectorStore));
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5 },
    });

    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "association",
      reason: "vector_store_lacks_get_vectors",
    });
    expect(result.memories.every((m) => m.retrievedVia !== "association")).toBe(true);
  });

  it("アンカーが0件（withinLimit が空）のとき stage_skipped(no_anchor) が立つ", async () => {
    const { runtime, stores } = buildRuntime();
    // クエリに全く当たらない記憶を1件だけ置く（below_threshold へ落ちる）。
    await createEmbeddedMemory(stores, [0, 1]);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5 },
    });

    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "association",
      reason: "no_anchor",
    });
    // association を申告した以上、byTier.association 欄は在る（走ったが収穫0）。
    // 欄自体が無い（＝申告していない）既定offの形とは区別する。
    expect(result.usage.byTier.association).toBe(0);
  });

  it("連想で拾った候補は retrievedVia:'association' と associationOf:<アンカー> を持ち、クエリには当たらない", async () => {
    const { runtime, stores } = buildRuntime();
    // Q = [1,0]。A はクエリに強く当たる（similarity ≈ 0.7071）→ アンカーになる。
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    // B はクエリには当たらない（similarity = 0 ちょうど、below_threshold）が、
    // アンカーとの類似度は 0.7071（既定 minSimilarity 0.5 以上）。
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const anchorEntry = result.memories.find((m) => m.memoryId === anchor.id);
    expect(anchorEntry?.retrievedVia).toBe("ann");
    // クエリとの類似度で拾われた側は affinityMeasured: true（Issue #548 方向1、ADR 0282）。
    expect(anchorEntry?.score.affinityMeasured).toBe(true);

    const assocEntry = result.memories.find((m) => m.memoryId === associated.id);
    expect(assocEntry).toBeDefined();
    expect(assocEntry?.retrievedVia).toBe("association");
    expect(assocEntry?.associationOf).toBe(anchor.id);
    // ⛔ アンカーとの類似度を score.similarity（クエリとの類似度の枠）に入れない。
    expect(assocEntry?.score.similarity).toBeUndefined();
    // ⟹ affinity が中立の1に退化しているので、この記憶の score.total は
    // affinityMeasured: true の記憶と比較可能ではない（Issue #548 方向1、ADR 0282）。
    expect(assocEntry?.score.affinityMeasured).toBe(false);

    // 既定 off のときには出ない stage_skipped が、ここでも出ていないこと
    // （実行して収穫が有った run では stage_skipped を積まない）。
    expect(
      result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "association"),
    ).toBe(false);

    // usage.byTier.association が実際の連想 digest の文字数を報告する。
    expect(result.usage.byTier.association).toBe("連想本文".length);
  });

  it("連想で拾った候補にも speaker/subjectId が在る（Issue #579 案D、ADR 0289。キーは常に在り、値は null になりうる）", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
      subjectId: "user:anchor",
      provenance: {
        kind: "stated",
        sourceObservationId: "obs-1",
        at: NOW.toISOString(),
        speaker: "アンカーの話者",
      },
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], {
      digest: "連想本文",
      subjectId: "user:associated",
      provenance: {
        kind: "inferred",
        model: "gpt-4o-mini",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: ["obs-1"] },
        confidence: 0.5,
      },
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const anchorEntry = result.memories.find((m) => m.memoryId === anchor.id)!;
    expect(anchorEntry.retrievedVia).toBe("ann");
    expect(Object.hasOwn(anchorEntry, "speaker")).toBe(true);
    expect(anchorEntry.speaker).toBe("アンカーの話者");
    expect(Object.hasOwn(anchorEntry, "subjectId")).toBe(true);
    expect(anchorEntry.subjectId).toBe("user:anchor");

    const assocEntry = result.memories.find((m) => m.memoryId === associated.id)!;
    expect(assocEntry.retrievedVia).toBe("association");
    expect(Object.hasOwn(assocEntry, "speaker")).toBe(true);
    expect(assocEntry.speaker).not.toBeUndefined();
    expect(assocEntry.speaker).toBeNull(); // inferred には speaker が無い
    expect(Object.hasOwn(assocEntry, "subjectId")).toBe(true);
    expect(assocEntry.subjectId).toBe("user:associated");
  });

  it("連想で拾った候補にも recordedAt/occurredAt が在る（Issue #691 の子、Issue #702、ADR 0298。キーは常に在り、occurredAt の値は null になりうる）", async () => {
    const { runtime, stores } = buildRuntime();
    const anchorRecordedAt = new Date("2026-03-01T00:00:00.000Z");
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
      recordedAt: anchorRecordedAt,
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const associatedRecordedAt = new Date("2026-03-02T00:00:00.000Z");
    const associated = await createEmbeddedMemory(stores, [0, 1], {
      digest: "連想本文",
      recordedAt: associatedRecordedAt,
      provenance: {
        kind: "inferred",
        model: "gpt-4o-mini",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: ["obs-1"] },
        confidence: 0.5,
      },
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const anchorEntry = result.memories.find((m) => m.memoryId === anchor.id)!;
    expect(anchorEntry.retrievedVia).toBe("ann");
    expect(Object.hasOwn(anchorEntry, "recordedAt")).toBe(true);
    expect(anchorEntry.recordedAt).toEqual(anchorRecordedAt);
    expect(Object.hasOwn(anchorEntry, "occurredAt")).toBe(true);
    expect(anchorEntry.occurredAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));

    const assocEntry = result.memories.find((m) => m.memoryId === associated.id)!;
    expect(assocEntry.retrievedVia).toBe("association");
    expect(Object.hasOwn(assocEntry, "recordedAt")).toBe(true);
    expect(assocEntry.recordedAt).not.toBeUndefined();
    expect(assocEntry.recordedAt).toEqual(associatedRecordedAt);
    expect(Object.hasOwn(assocEntry, "occurredAt")).toBe(true);
    expect(assocEntry.occurredAt).not.toBeUndefined();
    expect(assocEntry.occurredAt).toBeNull(); // occurredAt を渡していないので既定 null
  });

  it("既に返る集合（withinLimit）と重複しない", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [1, 0], { digest: "M1" });
    // M2 はクエリにも当たり（withinLimit に入る）、かつアンカーの近傍でもある。
    const alsoMain = await createEmbeddedMemory(stores, [0.99, 0.1411], { digest: "M2" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const mainEntry = result.memories.find((m) => m.memoryId === alsoMain.id);
    expect(mainEntry?.retrievedVia).toBe("ann");
    // M2 が association としてもう一度現れない。
    expect(result.memories.filter((m) => m.memoryId === alsoMain.id)).toHaveLength(1);
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
    // アンカー自身も連想として現れない。
    expect(result.memories.filter((m) => m.memoryId === anchor.id)).toHaveLength(1);
  });

  it("予算が厳しいとき、連想の候補が先に落ちて budget_dropped に乗る", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "AAAAA", // 5 chars
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], {
      digest: "BBBBB", // 5 chars
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
      budget: { maxMemoryChars: 5 }, // アンカー分だけは入るが、連想分は入らない
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(anchor.id);
    expect(memoryIds).not.toContain(associated.id);
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });

  it("予算に余裕があれば、連想の候補もそのまま返る", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "AAAAA",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "BBBBB" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
      budget: { maxMemoryChars: 100 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(anchor.id);
    expect(memoryIds).toContain(associated.id);
    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);
  });
});

describe("recall() — memories と omitted の排他性（Issue #421 / ADR 0203）", () => {
  it("段2で below_threshold として落ちた記憶が連想で丸ごと昇格すると、below_threshold の omission 自体が消える", async () => {
    const { runtime, stores } = buildRuntime();
    // A はクエリに強く当たる → アンカーになる。B はクエリには当たらない
    // （below_threshold）が、A との類似度は 0.7071（既定 minSimilarity 0.5 以上）
    // なので連想で拾われる——below_threshold の対象はこの1件だけである。
    await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    // ⭐ 陽性対照そのもの（Issue #421 が実測した形）: 修正前はここで
    // `result.memories` に retrievedVia:'association' として現れる一方、
    // `result.omitted` の below_threshold.nearMisses にも同じ id が残っていた。
    const assocEntry = result.memories.find((m) => m.memoryId === associated.id);
    expect(assocEntry?.retrievedVia).toBe("association");

    // below_threshold の対象は昇格した1件だけだったので、omission 自体が
    // 配列から消える（0件の omission を残さない、他の kind と同じ作法）。
    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);
    // 昇格した memoryId が、omitted のどのエントリにも（nearMisses という形でも）残らない。
    for (const o of result.omitted) {
      if (o.kind === "below_threshold") {
        expect(o.nearMisses?.some((n) => n.memoryId === associated.id)).toBe(false);
      }
    }
  });

  it("below_threshold の一部だけが連想で昇格したときは、残りだけが omitted に残る（count / nearMisses とも）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    // promoted: クエリには当たらない（below_threshold）が、A との類似度は高く連想で拾われる。
    const promoted = await createEmbeddedMemory(stores, [0, 1], { digest: "昇格する" });
    // stillOmitted: クエリにも A にも当たらない——below_threshold のまま残る。
    const stillOmitted = await createEmbeddedMemory(stores, [0, -1], { digest: "残る" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const promotedEntry = result.memories.find((m) => m.memoryId === promoted.id);
    expect(promotedEntry?.retrievedVia).toBe("association");
    expect(result.memories.some((m) => m.memoryId === stillOmitted.id)).toBe(false);

    const belowThreshold = result.omitted.find((o) => o.kind === "below_threshold");
    expect(belowThreshold).toBeDefined();
    if (belowThreshold?.kind === "below_threshold") {
      // count は「昇格した1件」の分だけ減っている（2件 below_threshold のうち1件が昇格）。
      expect(belowThreshold.count).toBe(1);
      expect(belowThreshold.nearMisses?.some((n) => n.memoryId === promoted.id)).toBe(false);
      expect(belowThreshold.nearMisses?.some((n) => n.memoryId === stillOmitted.id)).toBe(true);
    }
  });
});

describe("recall() — 連想枠: 複数アンカーが同じ候補を連想したときの決定性（Issue #316 / ADR 0167）", () => {
  const deg = (d: number): number => (d * Math.PI) / 180;

  it("VectorStore.getVectors が返す順序に依存せず、associationOf は常に anchors のランク順で先に処理されたアンカーになる", async () => {
    // Q=0°。A(40°)はB(55°)よりQに近い ⟹ 段1の再スコアでA=rank1、B=rank2（anchors=[A,B]）。
    // C(90°)はQとの類似度がほぼ0（below_threshold）なのでwithinLimitには入らず、連想でしか拾えない。
    //
    // ⭐ Cは B（sim≈0.819）のほうが A（sim≈0.643）より近い——だが ADR 0151 の決定
    // 「複数アンカーから同じ記憶が浮上しても、associationOf は最初に当たったアンカーだけを
    // 記録する」の「最初」は常に anchors のランク順（A→B）で決まらなければならず、
    // candidate 側（C）から見てどちらのアンカーに近いかで決めてはいけない。
    //
    // Issue #316 の実際の原因（ADR 0167）: `PostgresVectorStore.getVectors` は `ORDER BY`
    // を持たず、返す順序が ingest ごとにランダムな memory_id（UUID）の索引順になっていた
    // ——`recall-runtime.ts` がその返り値の順序をそのままアンカー処理順として使っていたため、
    // 「最初に当たったアンカー」が ingest ごとに入れ替わっていた。
    const q = [Math.cos(deg(0)), Math.sin(deg(0))];
    const aVec = [Math.cos(deg(40)), Math.sin(deg(40))];
    const bVec = [Math.cos(deg(55)), Math.sin(deg(55))];
    const cVec = [Math.cos(deg(90)), Math.sin(deg(90))];

    async function run(
      overrideVectorStore?: (stores: ReturnType<typeof createFakeRuntimeStores>) => VectorStore,
    ) {
      const { runtime, stores } = buildRuntime(overrideVectorStore);
      const a = await createEmbeddedMemory(stores, aVec, { digest: "A" });
      const b = await createEmbeddedMemory(stores, bVec, { digest: "B" });
      const c = await createEmbeddedMemory(stores, cVec, { digest: "C" });
      const result = await runtime.recall(ctx, {
        vector: q,
        association: { maxCount: 5, anchorCount: 2 },
      });
      const cEntry = result.memories.find((m) => m.memoryId === c.id);
      return { a, b, c, cEntry };
    }

    // forward: FakeVectorStore.getVectors は入力順（= anchors のランク順、A→B）を保って返す。
    const forward = await run();
    expect(forward.cEntry?.retrievedVia).toBe("association");
    expect(forward.cEntry?.associationOf).toBe(forward.a.id);

    // reversed: getVectors が B→A の順（anchors のランク順とは逆）で返す adapter を模す。
    // ⭐ ここが歯——バグがあると、先に処理される B が C を「最初に当たった」として横取りし、
    // associationOf が B になる（かつ similarity も 0.819 側に変わる）。
    const reversed = await run((s) => withReversedGetVectorsOrder(s.vectorStore));
    expect(reversed.cEntry?.retrievedVia).toBe("association");
    expect(reversed.cEntry?.associationOf).toBe(reversed.a.id);
  });
});

describe("recall() — 連想枠: anchorPool（規模への追随、Issue #377 / ADR 0306）", () => {
  const deg = (d: number): number => (d * Math.PI) / 180;

  /**
   * `limit` より多くの候補が段2の閾値を通っている状況（`over_limit(stage:'rescore')` が
   * 積まれる状況）を作り、`getVectors` に実際に渡された memoryId を spy で数える——
   * [PR #430](https://github.com/takecchi/mnemora/pull/430) が本物の Postgres に対して
   * 手動で数えた表（`limit:10/anchorCount:40 → 実アンカー10件`）と同じ量を、ここでは
   * 擬似実装の上で歯として固定する。
   */
  async function setupFiveCandidates(
    overrideVectorStore?: (stores: ReturnType<typeof createFakeRuntimeStores>) => VectorStore,
  ) {
    const { runtime, stores } = buildRuntime(overrideVectorStore);
    // クエリ [1,0] に対する類似度が単調に下がる5件。すべて既定の scoreThreshold(0.1) を
    // 楽に上回る（最小でも cos(25°) ≈ 0.906）——5件とも段2の閾値分割を通り、`passed` に入る。
    const angles = [5, 10, 15, 20, 25];
    const created: Memory[] = [];
    for (const a of angles) {
      created.push(
        await createEmbeddedMemory(stores, [Math.cos(deg(a)), Math.sin(deg(a))], {
          digest: `m${a}`,
        }),
      );
    }
    return { runtime, stores, created };
  }

  it("anchorPool を省略すると、実アンカー数は従来どおり limit で頭打ちになる（回帰）", async () => {
    const calls: MemoryId[][] = [];
    const { runtime, created } = await setupFiveCandidates((s) =>
      withGetVectorsSpy(s.vectorStore, calls),
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 2,
      association: { maxCount: 1, anchorCount: 5 },
    });

    // over_limit(stage:'rescore') が3件——5件通って上位2件だけが limit の内側。
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "over_limit", stage: "rescore", count: 3 }),
    );
    // anchorCount:5 を渡しても、getVectors に渡ったのは withinLimit の2件だけ
    // （min(anchorCount, limit, 通過数) = min(5, 2, 5) = 2）。
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(created.slice(0, 2).map((m) => m.id));
  });

  it("anchorPool: 'passed' を渡すと、limit を超えて段2の通過集合全体からアンカーを取れる", async () => {
    const calls: MemoryId[][] = [];
    const { runtime, created } = await setupFiveCandidates((s) =>
      withGetVectorsSpy(s.vectorStore, calls),
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 2,
      association: { maxCount: 1, anchorCount: 5, anchorPool: "passed" },
    });

    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "over_limit", stage: "rescore", count: 3 }),
    );
    // 同じ anchorCount:5 でも、母集合を passed にすると5件全部が実アンカーになる
    // （min(anchorCount, passed の件数) = min(5, 5) = 5）——limit(2) は天井にならない。
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(created.map((m) => m.id));
  });

  it("anchorPool: 'withinLimit' を明示しても、省略時と同じ挙動になる", async () => {
    const calls: MemoryId[][] = [];
    const { runtime, created } = await setupFiveCandidates((s) =>
      withGetVectorsSpy(s.vectorStore, calls),
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 2,
      association: { maxCount: 1, anchorCount: 5, anchorPool: "withinLimit" },
    });

    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "over_limit", stage: "rescore", count: 3 }),
    );
    expect(calls[0]).toEqual(created.slice(0, 2).map((m) => m.id));
  });

  /**
   * 内部の呼び出し回数だけでなく、`RecallResult` に実際に現れる効果でも確かめる——
   * `anchorPool: 'passed'` にしないと届かない候補が、`recall()` の返り値レベルで
   * `retrievedVia: 'association'` として現れることを検査する。
   *
   * 幾何: query=[1,0,0]。anchor1〜3 は xy 平面上（角度5°/15°/25°、query に近い順で
   * withinLimit（limit=3）に入る）。anchor4 は xz 平面上（角度35°、query との類似度
   * 0.819 で4位——`withinLimit` には入らないが `passed` には入る）。D も xz 平面上
   * （角度70°）に置き、D–anchor4 間の類似度 (cos35°≈0.819) は minSimilarity(0.5) を
   * 超えるが、D–anchor1..3 間の類似度（cos(角度)×cos70°、最大でも cos5°×cos70°≈0.34）は
   * 0.5 を下回るよう角度を選んだ——D は anchor4 経由でしか連想枠に現れない。
   */
  it("anchorPool: 'passed' でのみ、withinLimit の外に居るアンカー経由の候補が現れる", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor1 = await createEmbeddedMemory(stores, [Math.cos(deg(5)), Math.sin(deg(5)), 0], {
      digest: "anchor1",
    });
    await createEmbeddedMemory(stores, [Math.cos(deg(15)), Math.sin(deg(15)), 0], {
      digest: "anchor2",
    });
    await createEmbeddedMemory(stores, [Math.cos(deg(25)), Math.sin(deg(25)), 0], {
      digest: "anchor3",
    });
    const anchor4 = await createEmbeddedMemory(stores, [Math.cos(deg(35)), 0, Math.sin(deg(35))], {
      digest: "anchor4",
    });
    const d = await createEmbeddedMemory(stores, [Math.cos(deg(70)), 0, Math.sin(deg(70))], {
      digest: "D",
    });

    const query = { vector: [1, 0, 0], limit: 3 };

    const withDefaultPool = await runtime.recall(ctx, {
      ...query,
      association: { maxCount: 5, anchorCount: 4 },
    });
    expect(withDefaultPool.memories.some((m) => m.memoryId === d.id)).toBe(false);

    const withPassedPool = await runtime.recall(ctx, {
      ...query,
      association: { maxCount: 5, anchorCount: 4, anchorPool: "passed" },
    });
    const dEntry = withPassedPool.memories.find((m) => m.memoryId === d.id);
    expect(dEntry?.retrievedVia).toBe("association");
    expect(dEntry?.associationOf).toBe(anchor4.id);
    // 参照用に anchor1 を使っていることを明示する（未使用変数として消さない）。
    expect(withPassedPool.memories.some((m) => m.memoryId === anchor1.id)).toBe(true);
  });
});
