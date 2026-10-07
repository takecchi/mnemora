import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.findCorrectionCandidates`（ADR 0232）の確かめ直し（Issue #1812 まとまり G2）で
 * 変異試験がすり抜けた箇所の歯。既存の `correction-candidates*.test.ts` が縛っていなかった約束だけを置く:
 * 除外してから limit で切ること、`text` を加工せず recall へ渡すこと、`retrievedVia`/`score`/`omitted`/`explain`
 * を recall のまま運ぶこと、limit の上限を課さないこと。
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

/** `embed` に渡された文字列を記録する薄いラッパー。 */
function recordingEmbeddingProvider(inner: EmbeddingProvider): EmbeddingProvider & {
  texts: string[][];
} {
  const wrapper = {
    texts: [] as string[][],
    get space() {
      return inner.space;
    },
    async embed(c: Ctx, texts: string[]): Promise<number[][]> {
      wrapper.texts.push([...texts]);
      return inner.embed(c, texts);
    },
  };
  return wrapper;
}

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const embedding = recordingEmbeddingProvider(stores.embeddingProvider);
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
    embeddingProvider: embedding,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores, embedding };
}

/** `"seed"` は `[4, 0]` に埋め込まれる（`correction-candidates.test.ts` と同じ約束事）。 */
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

describe("findCorrectionCandidates — 除外してから limit で切る", () => {
  it("1位を除外し limit:2 を渡すと、recall の2位・3位が返る（limit で切ってから除外しない）", async () => {
    const { runtime, stores } = buildRuntime();
    const c1 = await createCandidate(stores, [8, 0], { digest: "c1" });
    const c2 = await createCandidate(stores, [8, 1], { digest: "c2" });
    const c3 = await createCandidate(stores, [8, 2], { digest: "c3" });
    await createCandidate(stores, [8, 4], { digest: "c4" });

    const result = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      limit: 2,
      excludeMemoryIds: [c1.id],
    });

    expect(result.candidates.map((c) => c.memoryId)).toEqual([c2.id, c3.id]);
    expect(result.candidates.map((c) => c.recallRank)).toEqual([2, 3]);
    expect(result.excludedCount).toBe(1);
    expect(result.recalledCount).toBe(4);
  });
});

describe("findCorrectionCandidates — limit に上限を課さない", () => {
  it("recall の既定件数（10）まで並べても、limit を大きく取れば全件が返る", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 8; i += 1) {
      await createCandidate(stores, [8, i * 0.2], { digest: `c${i}` });
    }

    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT, limit: 8 });
    expect(result.recalledCount).toBe(8);
    expect(result.candidates).toHaveLength(8);

    const huge = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(huge.candidates).toHaveLength(8);
  });
});

describe("findCorrectionCandidates — text を加工せず recall へ渡す", () => {
  // 前後の空白は `recall()` が `trim()` するので、ここでは区別できない（recall.ts 1775 行付近）。
  it("40字を超える text も、切らずにそのまま埋め込みに渡る", async () => {
    const text = Array.from({ length: 20 }, () => "seed").join(" ");
    const { runtime, stores, embedding } = buildRuntime();
    await createCandidate(stores, [8, 0], { digest: "c1" });

    await runtime.findCorrectionCandidates(ctx, { text });

    expect(embedding.texts).toEqual([[text]]);
  });
});

describe("findCorrectionCandidates — recall の内訳をそのまま運ぶ", () => {
  it("contested の対向（mandatory_companion）の retrievedVia と score を、recall のまま運ぶ", async () => {
    const { runtime, stores } = buildRuntime();
    const c1 = await createCandidate(stores, [8, 0], { digest: "c1" });
    // 埋め込みを持たない対向: ANN には現れず、必須の同伴取得だけが引ける。
    const c2 = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "c2" }));
    const marked = await runtime.markContested(ctx, c1.id, c2.id);
    expect(marked.outcome.kind).toBe("contested");

    const recalled = await runtime.recall(ctx, { text: QUERY_TEXT });
    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });

    const companion = recalled.memories.find((m) => m.memoryId === c2.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
    expect(result.candidates.map((c) => [c.memoryId, c.retrievedVia, c.score])).toEqual(
      recalled.memories.map((m) => [m.memoryId, m.retrievedVia, m.score]),
    );
  });

  it("連想枠（score.total を持たない）の候補も落とさず、recall のまま運ぶ", async () => {
    const { runtime, stores } = buildRuntime();
    // 直接ヒット: query [4,0] に対して類似度 0.707。
    const direct = await createCandidate(stores, [1, 1], { digest: "direct" });
    // query には当たらない（類似度 0 < 閾値）が、direct には近い ⟹ 連想枠で返る。
    const assoc = await createCandidate(stores, [0, 1], { digest: "assoc" });

    const recalled = await runtime.recall(ctx, { text: QUERY_TEXT });
    const viaAssoc = recalled.memories.find((m) => m.memoryId === assoc.id);
    expect(viaAssoc?.retrievedVia).toBe("association");

    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });
    expect(result.candidates.map((c) => c.memoryId)).toEqual([direct.id, assoc.id]);
    const got = result.candidates.find((c) => c.memoryId === assoc.id);
    expect(got?.retrievedVia).toBe("association");
    expect(got?.score).toEqual(viaAssoc?.score);
    expect(got?.score.affinityMeasured).toBe(false);
  });

  it("omitted と explain を、recall が返したままにする", async () => {
    const { runtime, stores } = buildRuntime();
    await createCandidate(stores, [8, 0], { digest: "c1" });
    // query と直交 ⟹ 閾値で落ちて omitted に載る。
    await createCandidate(stores, [0, 8], { digest: "far" });

    const recalled = await runtime.recall(ctx, { text: QUERY_TEXT });
    expect(recalled.omitted.length).toBeGreaterThan(0);
    expect(recalled.explain.stages.length).toBeGreaterThan(0);

    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });
    expect(result.omitted).toEqual(recalled.omitted);
    expect(result.explain.stages.map((s) => s.stage)).toEqual(
      recalled.explain.stages.map((s) => s.stage),
    );
  });
});
