import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { DEFAULT_RECALL_ASSOCIATION } from "../recall.js";
import { createRuntime } from "../runtime.js";
import {
  createFakeRuntimeStores,
  withoutGetVectors,
  withReversedGetVectorsOrder,
} from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。 */

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

describe("recall() — 連想枠（association、既定 on。ADR 0337）", () => {
  it("association を省略すると DEFAULT_RECALL_ASSOCIATION が適用され、byTier.association が現れる（既定 on）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "アンカー" });

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(
      result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "association"),
    ).toBe(false);
    expect(Object.keys(result.usage.byTier).sort()).toEqual([
      "association",
      "digest",
      "full",
      "index",
    ]);
    expect(result.usage.byTier.association).toBe(0);
    expect(result.memories.every((m) => m.retrievedVia !== "association")).toBe(true);
  });

  it("association: null を渡すと、連想は一切走らない（ADR 0151 以前の振る舞い、明示的な opt-out）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "アンカー" });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });

    expect(
      result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "association"),
    ).toBe(false);
    expect(Object.keys(result.usage.byTier).sort()).toEqual(["digest", "full", "index"]);
    expect(result.memories.every((m) => m.retrievedVia !== "association")).toBe(true);
  });

  it("association: null は、連想を有効にする候補が居ても一切拾わない（既定 on を確実に打ち消す）", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });

    expect(result.memories.some((m) => m.memoryId === associated.id)).toBe(false);
    expect(result.memories.find((m) => m.memoryId === anchor.id)?.retrievedVia).toBe("ann");
    expect("association" in result.usage.byTier).toBe(false);
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
    // 連想は走った（アンカーが無く no_anchor で終わった）ので、byTier.association 欄は在る。
    // 欄自体が無い（＝ null で明示的に off にした）形とは区別する。
    expect(result.usage.byTier.association).toBe(0);
  });

  it("連想で拾った候補は retrievedVia:'association' と associationOf:<アンカー> を持ち、クエリには当たらない", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const anchorEntry = result.memories.find((m) => m.memoryId === anchor.id);
    expect(anchorEntry?.retrievedVia).toBe("ann");
    expect(anchorEntry?.score.affinityMeasured).toBe(true);

    const assocEntry = result.memories.find((m) => m.memoryId === associated.id);
    expect(assocEntry).toBeDefined();
    expect(assocEntry?.retrievedVia).toBe("association");
    expect(assocEntry?.associationOf).toBe(anchor.id);
    expect(assocEntry?.score.affinityMeasured).toBe(false);
    expect(assocEntry?.score).not.toHaveProperty("similarity");
    expect(assocEntry?.score).not.toHaveProperty("total");

    expect(
      result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "association"),
    ).toBe(false);

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
    expect(result.memories.filter((m) => m.memoryId === alsoMain.id)).toHaveLength(1);
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
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

describe("recall() — 連想枠の既定値（ADR 0337 決定1。Issue #1775 の #838）", () => {
  it("DEFAULT_RECALL_ASSOCIATION は { maxCount: 10 }", () => {
    expect(DEFAULT_RECALL_ASSOCIATION).toEqual({ maxCount: 10 });
  });

  it("association を省略しても、連想でしか届かない記憶が retrievedVia:'association' で結果に入る（既定 on が実際に働く）", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.memories.find((m) => m.memoryId === anchor.id)?.retrievedVia).toBe("ann");
    const assocEntry = result.memories.find((m) => m.memoryId === associated.id);
    expect(assocEntry?.retrievedVia).toBe("association");
    expect(assocEntry?.associationOf).toBe(anchor.id);
  });
});

describe("recall() — memories と omitted の排他性（Issue #421 / ADR 0203）", () => {
  it("段2で below_threshold として落ちた記憶が連想で丸ごと昇格すると、below_threshold の omission 自体が消える", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const assocEntry = result.memories.find((m) => m.memoryId === associated.id);
    expect(assocEntry?.retrievedVia).toBe("association");

    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);
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
    const promoted = await createEmbeddedMemory(stores, [0, 1], { digest: "昇格する" });
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
      expect(belowThreshold.count).toBe(1);
      expect(belowThreshold.nearMisses?.some((n) => n.memoryId === promoted.id)).toBe(false);
      expect(belowThreshold.nearMisses?.some((n) => n.memoryId === stillOmitted.id)).toBe(true);
    }
  });
});

describe("recall() — 連想枠: 複数アンカーが同じ候補を連想したときの決定性（Issue #316 / ADR 0167）", () => {
  const deg = (d: number): number => (d * Math.PI) / 180;

  it("VectorStore.getVectors が返す順序に依存せず、associationOf は常に anchors のランク順で先に処理されたアンカーになる", async () => {
    // Q=0°、A=40°、B=55°、C=90°。C は B のほうが近い（sim≈0.819）が、associationOf は anchors のランク順（A→B）で
    // 最初に当たったアンカーになる。ランク順と近さを食い違わせてある。
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

    const forward = await run();
    expect(forward.cEntry?.retrievedVia).toBe("association");
    expect(forward.cEntry?.associationOf).toBe(forward.a.id);

    // getVectors が anchors のランク順と逆（B→A）で返す adapter を模す。
    // 実装が返り値の順をそのままアンカー処理順に使うと、B が C を横取りして associationOf が B になる。
    const reversed = await run((s) => withReversedGetVectorsOrder(s.vectorStore));
    expect(reversed.cEntry?.retrievedVia).toBe("association");
    expect(reversed.cEntry?.associationOf).toBe(reversed.a.id);
  });
});
