import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallStageName } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores, withoutGetVectors } from "./runtime-fakes.js";

/**
 * 段3.5（連想枠）は `explain.stages` に記録される（Issue #865、2026-09-29。`RecallStageName`
 * の TSDoc・`docs/recall.md` §1・§2・§9）。
 *
 * この歯は、以前（PR #1346）「記録しない」ことを縛っていた
 * `recall-explain-stages-omit-association.test.ts` を、新しい振る舞いに合わせて置き換えたもの
 * （ファイル名も改名した）。旧テストが確認していた「代わりの印」（`usage.byTier.association`・
 * `retrievedVia`/`associationOf`・`omitted` の `stage: "association"`）は今も変わらず出る——
 * ここが確認するのは、それに加えて `explain.stages` にも `stage: "association"` の trace が
 * 積まれるようになったことである。
 *
 * `RecallStageName` への値の追加は破壊的変更に数えない（オーナー回答 ask_human d9364c91）。
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

/** `RecallStageName` の今の値（型と同じ集合であることは、下の `satisfies` が型で確かめる）。 */
const STAGE_NAMES = [
  "scope",
  "candidate_generation",
  "rescore",
  "contradiction_resolution",
  "association",
  "budget_truncation",
  "index_band",
  "record",
] as const satisfies readonly RecallStageName[];

function stageNames(result: { explain: { stages: { stage: string }[] } }): string[] {
  return result.explain.stages.map((s) => s.stage);
}

function findStage<T extends { explain: { stages: { stage: string }[] } }>(
  result: T,
  stage: string,
) {
  return result.explain.stages.find((s) => s.stage === stage);
}

describe("段3.5（連想枠）は explain.stages に記録される（Issue #865）", () => {
  it("連想で候補を拾った run は、stages に association(executed:true) が出て、代わりの印も変わらず出る", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    const assocEntry = result.memories.find((m) => m.memoryId === associated.id);
    expect(assocEntry?.retrievedVia).toBe("association");
    expect(assocEntry?.associationOf).toBe(anchor.id);
    expect(result.usage.byTier.association).toBeGreaterThan(0);

    const names = stageNames(result);
    expect(names.every((name) => (STAGE_NAMES as readonly string[]).includes(name))).toBe(true);

    const assocStage = findStage(result, "association");
    expect(assocStage).toEqual({
      stage: "association",
      executed: true,
      detail: { anchors: 1, hits: 1, selected: 1 },
    });
    // 段の並びは段3(contradiction_resolution)の直後・段4(budget_truncation)の直前
    // (docs/recall.md §2・§9、番号を3.5にしてあるのはこの位置を表すため)。
    expect(names.indexOf("association")).toBe(names.indexOf("contradiction_resolution") + 1);
    expect(names.indexOf("association")).toBe(names.indexOf("budget_truncation") - 1);
  });

  it("association: null（明示 off）にした run は、stages に association の trace が一切出ない（他の段の並びは同じ）", async () => {
    const on = buildRuntime();
    await createEmbeddedMemory(on.stores, [0.70710678, 0.70710678], { digest: "アンカー本文" });
    await createEmbeddedMemory(on.stores, [0, 1], { digest: "連想本文" });
    const off = buildRuntime();
    await createEmbeddedMemory(off.stores, [0.70710678, 0.70710678], { digest: "アンカー本文" });
    await createEmbeddedMemory(off.stores, [0, 1], { digest: "連想本文" });

    const withAssociation = await on.runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });
    const withoutAssociation = await off.runtime.recall(ctx, { vector: [1, 0], association: null });

    expect(withAssociation.memories.some((m) => m.retrievedVia === "association")).toBe(true);
    expect("association" in withoutAssociation.usage.byTier).toBe(false);

    expect(stageNames(withoutAssociation).includes("association")).toBe(false);
    // off の stages は、on の stages から association の trace を除いたものと一致する
    // ——`null` で明示的に off にしたときは、他のどの段の並びも変わらない。
    expect(stageNames(withoutAssociation)).toEqual(
      stageNames(withAssociation).filter((name) => name !== "association"),
    );
  });

  it("連想枠を飛ばした run（アンカーが0件）は、stages に association(executed:false) が出て omitted の stage_skipped(no_anchor) と対になる", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0, 1]);

    const result = await runtime.recall(ctx, { vector: [1, 0], association: { maxCount: 5 } });

    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "association",
      reason: "no_anchor",
    });
    expect(result.usage.byTier.association).toBe(0);
    expect(findStage(result, "association")).toEqual({
      stage: "association",
      executed: false,
      detail: { anchors: 0, hits: 0, selected: 0 },
    });
  });

  it("アンカーは在ったが連想の検索結果が0件の run は、association(executed:true) のまま（探して0件と、探さなかったを混ぜない）", async () => {
    const { runtime, stores } = buildRuntime();
    // 記憶はアンカー1件だけ。アンカー自身は連想の候補にならないので、検索は走るが0件になる。
    await createEmbeddedMemory(stores, [1, 0], { digest: "アンカー本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
    // 探さなかった（no_anchor）の印は出ない
    expect(result.omitted).not.toContainEqual({
      kind: "stage_skipped",
      stage: "association",
      reason: "no_anchor",
    });
    expect(findStage(result, "association")).toEqual({
      stage: "association",
      executed: true,
      detail: { anchors: 1, hits: 0, selected: 0 },
    });
  });

  it("detail は件数の書き写し: 連想の候補が席（maxCount）より多いとき、hits は見つけた件数、selected は席に着いた件数", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0.70710678, 0.70710678], { digest: "アンカー本文" });
    // クエリ [1, 0] には当たらず（ann の閾値の下）、アンカーには近い候補を3件。
    await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文1" });
    await createEmbeddedMemory(stores, [-0.1, 0.995], { digest: "連想本文2" });
    await createEmbeddedMemory(stores, [-0.2, 0.98], { digest: "連想本文3" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 1, anchorCount: 1 },
    });

    expect(result.memories.filter((m) => m.retrievedVia === "association")).toHaveLength(1);
    expect(findStage(result, "association")).toEqual({
      stage: "association",
      executed: true,
      detail: { anchors: 1, hits: 3, selected: 1 },
    });
  });

  it("VectorStore.getVectors を持たない adapter では、stages に association(executed:false) が出て omitted の stage_skipped(vector_store_lacks_get_vectors) と対になる", async () => {
    const { runtime, stores } = buildRuntime((s) => withoutGetVectors(s.vectorStore));
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "association",
      reason: "vector_store_lacks_get_vectors",
    });
    expect(findStage(result, "association")).toEqual({
      stage: "association",
      executed: false,
      detail: { anchors: 0, hits: 0, selected: 0 },
    });
  });
});
