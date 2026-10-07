import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { heuristicTokenCounter } from "../heuristic-token-counter.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import {
  ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE,
  LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
  RecallQuerySchema,
} from "../recall.js";
import type { RecallChannel } from "../recall.js";
import { assertAffinityMeasured, createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。語彙 store は `runtime-fakes.ts` の `FakeLexicalStore` を使う。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10; // 長い half-life。テスト内で減衰させない。
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

/** `lexicalStore` を配線するかどうかを呼び出し側が選べる（「配線しない」側を使う歯がある）。 */
function buildRuntime(
  opts: { wireLexicalStore?: boolean; embeddingProvider?: EmbeddingProvider } = {},
) {
  const stores = createFakeRuntimeStores();
  const wireLexicalStore = opts.wireLexicalStore ?? true;
  const embeddingProvider = opts.embeddingProvider ?? stores.embeddingProvider;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: wireLexicalStore ? stores.lexicalStore : undefined,
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
    embeddingProvider,
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

describe("recall() — 歯①: 固有名詞・識別子は ann では引けず lexical では引ける（ADR 0084、Issue #106）", () => {
  /** gold と distractor に同一ベクタを渡す。埋め込みだけでは見分けられない状況を意図的に固定し、語彙チャンネルという別経路の機構を検査する（実 embedding の性能を測る歯ではない）。 */
  const V = [1, 0];

  async function seedFixture(stores: ReturnType<typeof createFakeRuntimeStores>) {
    // 挿入順を distractor → irrelevant → gold にする。同着のとき ANN 窓（kPrime=1）は挿入順の先頭だけを残すので、
    // gold を最後に挿れると、スコアで負けるのではなく窓の外に構造的に押し出される。
    const distractor = await createEmbeddedMemory(stores, V, {
      digest: "対応メモ",
      content: "PROJ-5678 の障害対応メモ。対応者は山田。",
      tags: [],
    });
    const irrelevant = await createEmbeddedMemory(stores, V, {
      digest: "無関係なメモ",
      content: "たなばたのイベント企画メモ。飾り付けの担当を決める。",
      tags: [],
    });
    const gold = await createEmbeddedMemory(stores, V, {
      digest: "対応メモ",
      // 識別子 "PROJ-1234" は content だけに書く（digest / tags 等には書かない）。マッチが content 起点であることを保証するため。
      content: "PROJ-1234 の障害対応メモ。対応者は鈴木。",
      tags: ["gold-tag"],
    });
    return { distractor, irrelevant, gold };
  }

  it("偽陽性の点検: FakeLexicalStore.search('PROJ-1234', ...) は gold だけを返す（全件返しではない）", async () => {
    const stores = createFakeRuntimeStores();
    const { distractor, irrelevant, gold } = await seedFixture(stores);

    const hits = await stores.lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId, status: ["active", "contested"] },
    });
    const hitIds = hits.map((h) => h.memoryId).sort();
    expect(hitIds).toEqual([gold.id].sort());
    expect(hitIds).not.toContain(distractor.id);
    expect(hitIds).not.toContain(irrelevant.id);
  });

  it("channels: ['ann']（既定）では、ann の窓の外に押し出された gold は結果に入らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { gold } = await seedFixture(stores);

    for (const channels of [undefined, ["ann"] as RecallChannel[]]) {
      const result = await runtime.recall(ctx, {
        vector: V,
        limit: 1,
        overFetchFactor: 1, // kPrime = 1
        ...(channels === undefined ? {} : { channels }),
      });
      expect(result.memories.map((m) => m.memoryId)).not.toContain(gold.id);
    }
  });

  it("channels: ['ann', 'lexical'] では gold が結果に入り、retrievedVia/score.lexicalMatch が語彙経路を名乗る", async () => {
    const { runtime, stores } = buildRuntime();
    const { distractor, irrelevant, gold } = await seedFixture(stores);

    const result = await runtime.recall(ctx, {
      vector: V,
      text: "PROJ-1234",
      tags: ["gold-tag"],
      channels: ["ann", "lexical"],
      limit: 1,
      overFetchFactor: 1, // kPrime = 1
      // association: null は、語彙チャンネルの効果だけを見るため。limit の外に押し出された distractor はアンカーに近く、連想の対象になりうる。
      association: null,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(gold.id);
    expect(ids).not.toContain(irrelevant.id);
    expect(ids).not.toContain(distractor.id);

    const returnedGold = result.memories.find((m) => m.memoryId === gold.id);
    expect(returnedGold).toBeDefined();
    expect(returnedGold?.retrievedVia).toBe("lexical");
    // クエリは単一語なので coverage は 1。定数の期待ではなく、単一語であることの帰結として書く。
    if (returnedGold === undefined) throw new Error("returnedGold not found");
    assertAffinityMeasured(returnedGold.score);
    expect(returnedGold.score.lexicalMatch).toBe(1);
  });
});

describe("recall() — 歯⑨: score.lexicalMatch は adapter が返した coverage そのもの（ADR 0092）", () => {
  it("2語のクエリのうち1語しか含まない記憶は、score.lexicalMatch が 0.5 になる（定数 1 ではない）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "alpha だけを含み、もう一方の語は現れない記録", digest: "half" }),
    );

    const result = await runtime.recall(ctx, {
      text: "alpha beta",
      channels: ["lexical"],
      limit: 10,
    });

    expect(result.memories).toHaveLength(1);
    // 定数 1 を期待しない: 一致語彙数1 ÷ クエリ語彙数2 = 0.5。
    assertAffinityMeasured(result.memories[0]!.score);
    expect(result.memories[0]?.score.lexicalMatch).toBeCloseTo(0.5);
  });

  it("被覆率が高い候補ほど affinity が高く、上位に来る（同一 rank 変域では coverage が順序を決める）", async () => {
    const { runtime, stores } = buildRuntime();
    const full = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "alpha と beta の両方を含む記録", digest: "full" }),
    );
    const half = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "alpha だけを含み、もう一方の語は現れない記録", digest: "half" }),
    );

    const result = await runtime.recall(ctx, {
      text: "alpha beta",
      channels: ["lexical"],
      limit: 10,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toEqual([full.id, half.id]);
    assertAffinityMeasured(result.memories[0]!.score);
    assertAffinityMeasured(result.memories[1]!.score);
    expect(result.memories[0]?.score.lexicalMatch).toBe(1);
    expect(result.memories[1]?.score.lexicalMatch).toBeCloseTo(0.5);
    expect(result.memories[0]!.score.total).toBeGreaterThan(result.memories[1]!.score.total);
  });

  it("similarity との max の関係は変わっていない: coverage(0.5) < similarity(1) のとき similarity が勝つ", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await createEmbeddedMemory(stores, [1, 0], {
      content: "alpha だけを含み、もう一方の語は現れない記録",
      digest: "both-channels",
      tags: [],
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      text: "alpha beta",
      channels: ["ann", "lexical"],
      limit: 10,
    });

    const hit = result.memories.find((m) => m.memoryId === memory.id);
    expect(hit).toBeDefined();
    assertAffinityMeasured(hit!.score);
    expect(hit?.score.similarity).toBe(1);
    expect(hit?.score.lexicalMatch).toBeCloseTo(0.5);
    expect(hit?.score.total).toBe(1);
  });
});

describe("recall() — 歯②: 既定(channels 未指定)は ADR 0084 以前と1バイトも変わらない", () => {
  // 期待値は、フィクスチャ作成時に自分で書いた定数からだけ組み立てる（`stores`/`memory` を後から読み返さない。`memory.id` だけは例外）。
  // in-memory 実装が返す Map の行への生きた参照から期待値を作ると、実装のバグと期待値が同時に動いて赤くならないため。
  // `Clock` は固定注入し、decay/freshness の起点はすべてフィクスチャの `recordedAt`（= NOW）から計算する（壁時計を紛れ込ませない）。

  it("②-a 全体の一致: RecallResult 全体を JSON 直列化してリテラルと突き合わせる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await createEmbeddedMemory(stores, [1, 0], {
      digest: "D",
      tags: [],
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    // 非決定な欄（recallId）は、非空文字列であることを別に確かめてから、
    // 比較用の JSON では固定のプレースホルダに差し替える（黙って落とさない）。
    expect(typeof result.recallId).toBe("string");
    expect(result.recallId.length).toBeGreaterThan(0);

    // recall() の後に同じ Memory を別の書き込みで変異させる。RecalledMemory が生きた参照を保持していたら、比較に漏れて赤くなる。
    await stores.memoryStore.reinforce(ctx, memory.id, new Date("2030-01-01T00:00:00.000Z"));
    await stores.memoryStore.updateStatus(ctx, memory.id, "active");

    const expectedIndexBand = {
      groups: [{ axis: "subject", key: null, count: 1, countKind: "exact" }],
      totalInScope: 1,
      countKind: "exact",
      digestBand: [] as unknown[],
      digestBandCoverage: { shown: 0, eligible: 0, countKind: "exact" },
    };
    const indexBandText = JSON.stringify(expectedIndexBand);
    const digestChars = "D".length;
    const indexChars = indexBandText.length;
    const tokenCount = heuristicTokenCounter.count("D" + indexBandText);

    const expected: unknown = {
      recallId: "RECALL_ID_PLACEHOLDER",
      memories: [
        {
          memoryId: memory.id,
          digest: "D",
          retrievedVia: "ann",
          provenanceKind: "imported",
          score: {
            similarity: 1,
            decay: 1,
            tagMatch: 1,
            freshness: 1,
            strength: 1,
            total: 1,
            affinityMeasured: true,
          },
          speaker: null,
          subjectId: null,
          recordedAt: NOW.toISOString(),
          occurredAt: null,
          attributes: {},
        },
      ],
      omitted: [],
      index: expectedIndexBand,
      usage: {
        chars: digestChars + indexChars,
        estimatedTokens: tokenCount.tokens,
        counter: "heuristic",
        byTier: { full: 0, digest: digestChars, index: indexChars, association: 0 },
        indexChars,
      },
      explain: {
        stages: [
          {
            stage: "scope",
            executed: true,
            detail: {
              subjectId: null,
              occurredAfter: null,
              occurredBefore: null,
              validAt: NOW.toISOString(),
              attributes: null,
              labels: null,
            },
          },
          {
            stage: "candidate_generation",
            executed: true,
            detail: {
              channel: "ann",
              kPrime: 40,
              hits: 1,
              decayGate: "pushed_down",
              clock: "wall",
              validityGate: "pushed_down",
            },
          },
          {
            stage: "rescore",
            executed: true,
            detail: { scored: 1, passedThreshold: 1, notComparable: 0, withinLimit: 1 },
          },
          { stage: "contradiction_resolution", executed: true, detail: { companionsAdded: 0 } },
          {
            stage: "association",
            executed: true,
            detail: { anchors: 1, hits: 0, selected: 0 },
          },
          {
            stage: "budget_truncation",
            executed: true,
            detail: { budgetApplied: false, unitsKept: 1 },
          },
          { stage: "index_band", executed: true, detail: { totalInScope: 1 } },
          { stage: "record", executed: true },
        ],
      },
      outputValidation: { ok: true, issues: [] },
    };

    // JSON 往復で Date 等を安定した plain data に落とし、`result` 自体への生きた参照も断つ。
    const actual = JSON.parse(JSON.stringify(result)) as { recallId: string };
    actual.recallId = "RECALL_ID_PLACEHOLDER";
    expect(actual).toEqual(expected);
  });

  it("②-b 語彙 store に触れないこと: search が throw する FakeLexicalStore を配線しても、既定の recall() は投げない", async () => {
    const { runtime, stores } = buildRuntime();
    stores.lexicalStore.shouldThrow = true;
    await createEmbeddedMemory(stores, [1, 0]);

    // channels を渡さない = 既定(ANN のみ)。これが lexicalStore.search を一度でも呼んでいたら、
    // shouldThrow によって例外が飛び、この await が reject して歯が落ちる。
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(stores.lexicalStore.calls.length).toBe(0);
  });

  it("②-c 形の一致: candidate_generation の trace はちょうど1つ、score に lexicalMatch という鍵が無い", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [0.9, 0.1]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const candidateTraces = result.explain.stages.filter((s) => s.stage === "candidate_generation");
    expect(candidateTraces).toHaveLength(1);
    expect(candidateTraces[0]?.detail).toEqual({
      channel: "ann",
      kPrime: 40,
      hits: 2,
      decayGate: "pushed_down",
      clock: "wall",
      validityGate: "pushed_down",
    });

    expect(result.memories.length).toBeGreaterThan(0);
    for (const m of result.memories) {
      // `undefined` との比較（`m.score.lexicalMatch === undefined`）ではなく、
      // 鍵そのものの有無を Object.keys の完全一致で見る——
      // `{ lexicalMatch: undefined, ... }` という壊れた実装も後者でなければ通ってしまう。
      expect(Object.keys(m.score)).not.toContain("lexicalMatch");
    }
  });
});

describe("recall() — 歯③: explain にチャンネルの出どころが出る（ADR 0084 §6）", () => {
  it("channels: ['ann','lexical'] のとき candidate_generation の trace が2つ、channel が 'ann'/'lexical'", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { content: "PROJ-1234 に関する記録" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      text: "PROJ-1234",
      channels: ["ann", "lexical"],
    });

    const candidateTraces = result.explain.stages.filter((s) => s.stage === "candidate_generation");
    expect(candidateTraces).toHaveLength(2);
    const channels = candidateTraces.map((t) => (t.detail as { channel: string }).channel).sort();
    expect(channels).toEqual(["ann", "lexical"]);
  });
});

describe("recall() — 歯④: lexicalStore が配線されていないのに channels: ['lexical'] を渡すと投げる", () => {
  it("エラーメッセージは LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX を名乗る（書き写さない）", async () => {
    const { runtime } = buildRuntime({ wireLexicalStore: false });
    await expect(runtime.recall(ctx, { text: "何か", channels: ["lexical"] })).rejects.toThrow(
      LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
    );
  });
});

describe("recall() — 歯⑤: channels: ['lexical'] のとき埋め込み provider は一度も呼ばれない", () => {
  it("EmbeddingProvider.embed の呼び出し回数が 0", async () => {
    const stores0 = createFakeRuntimeStores();
    let embedCalls = 0;
    const countingEmbeddingProvider: EmbeddingProvider = {
      space: stores0.embeddingProvider.space,
      embed: async (c, texts) => {
        embedCalls += 1;
        return stores0.embeddingProvider.embed(c, texts);
      },
    };
    const { runtime, stores } = buildRuntime({ embeddingProvider: countingEmbeddingProvider });
    // buildRuntime は独自の stores を作るので、上の stores0 とは別物——
    // ここでは countingEmbeddingProvider の「呼ばれた回数」だけを見るので問題ない。
    await createEmbeddedMemory(stores, [1, 0], { content: "PROJ-1234 に関する記録" });

    const result = await runtime.recall(ctx, { text: "PROJ-1234", channels: ["lexical"] });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(embedCalls).toBe(0);
  });
});

describe("recall() — 歯⑥: 語彙チャンネルが窓を埋めると lexical_truncated が出る（ADR 0084 §7）", () => {
  it("lexicalHits.length >= kPrime のとき omitted に { kind: 'lexical_truncated', countKind: 'unknown' }", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "PROJ-1234 の記録その1", digest: "1" }),
    );

    const result = await runtime.recall(ctx, {
      text: "PROJ-1234",
      channels: ["lexical"],
      limit: 1,
      overFetchFactor: 1, // kPrime = 1、lexicalHits も1件 -> 窓を埋める
    });

    expect(result.omitted).toContainEqual({ kind: "lexical_truncated", countKind: "unknown" });
  });

  it("⚠ 鳴ってはいけない側: 候補が kPrime 未満なら lexical_truncated は出ない", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "PROJ-1234 の記録その1", digest: "1" }),
    );

    const result = await runtime.recall(ctx, {
      text: "PROJ-1234",
      channels: ["lexical"],
      limit: 10,
      overFetchFactor: 4, // kPrime = 40 > 1件
    });
    expect(result.omitted.some((o) => o.kind === "lexical_truncated")).toBe(false);
  });
});

describe("recall() — 歯⑦: 語彙チャンネルが走った run では ann_truncated が undecidable になる（ADR 0084 §7）", () => {
  it("certainty: 'undecidable' で undecidableReason が ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE と一致", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { content: "無関係な記録" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      text: "何か関係ない語", // embeddableText が要る(空だと lexical はスキップされる)。ヒット数は関係ない。
      channels: ["ann", "lexical"],
      limit: 1,
      overFetchFactor: 1, // kPrime = 1、ANN 候補1件で窓が埋まる
    });

    const found = result.omitted.find((o) => o.kind === "ann_truncated");
    if (found === undefined || found.kind !== "ann_truncated") {
      throw new Error("ann_truncated が積まれていない");
    }
    expect(found.certainty).toBe("undecidable");
    expect(found.undecidableReason).toBe(ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE);
  });
});

describe("recall() — 歯⑧: RecallQuerySchema は channels の未知の値を拒否する（RECALL_CHANNELS が唯一の出所）", () => {
  it("channels: ['recent'] は拒否される", () => {
    // `safeParse` は `unknown` を受けるので型検査では弾けない——実行時に zod が弾くことを見る歯。
    const parsed = RecallQuerySchema.safeParse({ channels: ["recent"] });
    expect(parsed.success).toBe(false);
  });

  it("⚠ 鳴ってはいけない側: channels: ['ann','lexical'] は受理される", () => {
    const parsed = RecallQuerySchema.safeParse({ channels: ["ann", "lexical"] });
    expect(parsed.success).toBe(true);
  });
});
