import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * roadmap.md 段階4「想起」・段階5「説明」の完了条件そのものを検査する。
 *
 * - omitted の各 kind（stage_skipped/filtered/below_threshold/over_limit/budget_dropped/
 *   not_indexed/ann_truncated）が実際に発生する条件下で返せること。
 * - 段3（矛盾の解決）の mandatory companion retrieval と隣接性。
 * - 段4（予算切り詰め）が同伴ペアを分割しないこと。
 * - 被覆不変条件（groups の総和 == totalInScope）。
 * - explain.stages が実際に走った/走らなかった段を反映すること。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 */

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

/**
 * `ann_unreached`（ADR 0026）の歯のためだけの、`VectorStore` の薄いラッパー。
 *
 * `FakeVectorStore`（`runtime-fakes.ts`）は「本物同様に status/decayFloor でフィルタしつつ
 * cosine 距離で ANN を模する」ことはできるが、「scope にもっと候補があるのに、ANN が
 * それより少ない件数しか返さない」——近似索引が届かなかった、という状況そのものは
 * 作れない（`limit` まで律儀に返してしまう）。この状況を作るのに `runtime-fakes.ts`
 * 自体を変える必要は無く、`search` の返り件数を後から切り詰めるだけで足りるので、
 * ここに局所的なラッパーとして置く（`runtime-fakes.ts` は変更しない）。
 */
class CappedVectorStore implements VectorStore {
  constructor(
    private readonly inner: VectorStore,
    private readonly cap: number,
  ) {}

  upsert(...args: Parameters<VectorStore["upsert"]>): ReturnType<VectorStore["upsert"]> {
    return this.inner.upsert(...args);
  }

  async search(...args: Parameters<VectorStore["search"]>): ReturnType<VectorStore["search"]> {
    const hits = await this.inner.search(...args);
    return hits.slice(0, this.cap);
  }

  delete(...args: Parameters<VectorStore["delete"]>): ReturnType<VectorStore["delete"]> {
    return this.inner.delete(...args);
  }
}

/** `buildRuntime()` と同じ配線だが、`vectorStore` だけ `CappedVectorStore` に差し替える。 */
function buildRuntimeWithCappedAnn(cap: number) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: new CappedVectorStore(stores.vectorStore, cap),
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
  // `createEmbeddedMemory` は `stores.vectorStore.upsert` を直接呼ぶ想定なので、
  // 返す `stores` は素の（capされていない）参照のままにする——upsert は cap の対象外。
  return { runtime, stores };
}

/** 埋め込み済みの Memory を1件用意する（vectorStore への upsert も行う）。 */
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

describe("recall() — omitted.kind = 'stage_skipped'（候補生成、docs/recall.md §2 段1）", () => {
  it("text も vector も無いと candidate_generation は 'empty_query_content' で skip される", async () => {
    const { runtime } = buildRuntime();
    const result = await runtime.recall(ctx, {});
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "empty_query_content",
    });
    expect(result.memories).toEqual([]);
    const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
    expect(trace?.executed).toBe(false);
  });

  it("embedding provider が失敗すると 'embedding_provider_unavailable' で skip される", async () => {
    const { runtime, stores } = buildRuntime();
    stores.embeddingProvider.shouldFail = true;
    const result = await runtime.recall(ctx, { text: "何かのクエリ" });
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "embedding_provider_unavailable",
    });
  });
});

describe("recall() — omitted.kind = 'filtered'（スコープを定義するフィルタ。マネージャー決定）", () => {
  it("status='archived' は totalInScope に含まれず、filtered(archived) として報告される", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { status: "active" });
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "archived",
      count: 1,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(1);
  });

  it("status='superseded'/'forgotten' は別々の filtered omission として報告される（ADR 0027、束ねない）", async () => {
    const { runtime, stores } = buildRuntime();
    // 件数をわざと非対称にする（3 と 5）。1件ずつだと、取り違え
    // （superseded と forgotten を入れ替えて push する）も、束ねたまま
    // （両方を1つの omission に合算する）も、どちらも見抜けない。3 と 5 なら、
    // 束ねれば8、取り違えれば5/3になり、どちらも必ず落ちる。
    for (let i = 0; i < 3; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory({ status: "superseded" }));
    }
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    }

    const result = await runtime.recall(ctx, {});
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "superseded",
      count: 3,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      count: 5,
      countKind: "exact",
    });
    // 束ねられていないこと（"status" という condition はもう存在しない）を確認する。
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "status" }),
    );
  });

  it("occurredAfter の外にある Memory は filtered(period) に報告され、totalInScope から除かれる", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ occurredAt: new Date("2020-01-01T00:00:00.000Z") }),
    );
    await createEmbeddedMemory(stores, [1, 0], {
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      occurredAfter: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "period",
      count: 1,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(1);
  });
});

describe("recall() — omitted.kind = 'not_indexed'（docs/recall.md §4）", () => {
  it("embeddingStatus !== 'ready' な in-scope Memory は not_indexed として報告される（totalInScope には残る）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, newMemory({ embeddingStatus: "pending" }));

    const result = await runtime.recall(ctx, {});
    expect(result.omitted).toContainEqual({
      kind: "not_indexed",
      reason: "pending",
      count: 1,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(1);
  });
});

describe("recall() — omitted.kind = 'below_threshold'（docs/recall.md §2 段2）", () => {
  it("similarity が低く score.total が閾値未満の候補は below_threshold へ回り、memories には出ない", async () => {
    const { runtime, stores } = buildRuntime();
    // クエリベクトル [1,0] に対して直交する [0,1] は cosine 類似度 0 -> total は 0 になる。
    await createEmbeddedMemory(stores, [0, 1]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toEqual([]);
    const omission = result.omitted.find((o) => o.kind === "below_threshold");
    expect(omission).toBeDefined();
    if (omission?.kind === "below_threshold") {
      expect(omission.count).toBe(1);
      expect(omission.countKind).toBe("exact");
      expect(omission.nearMisses?.[0]?.score).toBeCloseTo(0, 10);
    }
  });
});

describe("recall() — omitted.kind = 'over_limit'（docs/recall.md §2 段2）", () => {
  it("閾値を超える候補が limit より多いと over_limit として報告される", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1, overFetchFactor: 10 });
    expect(result.memories).toHaveLength(1);
    expect(result.omitted).toContainEqual({ kind: "over_limit", count: 1, countKind: "exact" });
  });
});

describe("recall() — omitted.kind = 'ann_truncated'（docs/recall.md §3）", () => {
  it("ANN の返り件数が over-fetch 上限 k' に達したら ann_truncated が付く", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // limit=1, overFetchFactor=1 -> k'=1。候補が2件あるのに1件しか返らないので打ち切りが起きる。
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1, overFetchFactor: 1 });
    expect(result.omitted).toContainEqual({ kind: "ann_truncated", countKind: "unknown" });
  });

  it("候補が k' 未満ならフルスキャンと同精度になり ann_truncated は付かない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, overFetchFactor: 4 });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(false);
  });
});

describe("recall() — omitted.kind = 'ann_unreached'（ADR 0025 の実測、ADR 0026 の決定）", () => {
  it("歯A（鳴る側）: scope に候補が多くあるのに ANN が eligible 未満しか返さないと ann_unreached が付く", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(2);
    // 5件が scope 内・embeddingStatus='ready'（= eligible = 5）だが、ANN は2件しか返さない
    // （CappedVectorStore が模する「近似索引が届かなかった」状況。2 < kPrime(=40) かつ
    // 2 < eligible(=5) なので発火するはず）。
    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.omitted).toContainEqual({ kind: "ann_unreached", countKind: "unknown" });
  });

  it("歯B（⭐ 鳴ってはいけない側。オーナー名指し）: scope の候補を全部 ANN が返した場合は ann_unreached が鳴らない", async () => {
    const { runtime, stores } = buildRuntime();
    // 候補3件・kPrime=40（limit10×overFetchFactor4）・hits=3。3 < 40 だが 3 == eligible なので
    // 発火してはいけない——ここが赤くなったら「常に鳴る」側へ倒れたことを意味する。
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, overFetchFactor: 4 });
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
  });

  it("歯C: ann_truncated が鳴る状況（hits == k'）では ann_unreached は同時に鳴らない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // limit=1, overFetchFactor=1 -> k'=1。候補2件のうち1件しか返らないので ann_truncated が鳴る。
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1, overFetchFactor: 1 });
    expect(result.omitted).toContainEqual({ kind: "ann_truncated", countKind: "unknown" });
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
  });
});

describe("recall() — 段3: 矛盾の解決と必須の同伴取得（docs/recall.md §8）", () => {
  async function setupContestedPair(stores: ReturnType<typeof createFakeRuntimeStores>) {
    // b を先に作り、a から b を指す(一対一の対向関係。docs/memory-model.md §5)。
    // このテストが必要とするのは a.contestedWithId -> b の一方向だけ
    // (段3の実装は「候補として見つかった側」から対向を辿るため)。
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "B".repeat(20) }),
    );
    const a = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: b.id,
      digest: "A".repeat(5),
    });
    return { a, b };
  }

  it("contested な Memory が候補に入ると、対向する Memory がスコアに関係なく同伴取得される", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    const companion = result.memories.find((m) => m.memoryId === b.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
    expect(companion?.companionOf).toBe(a.id);
  });

  it("同伴取得された Memory は提示順で必ず隣接する", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);
    // 無関係な候補をもう1件混ぜて、隣接性が並び替えで崩れないことを確認する。
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "C" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5 });
    const ids = result.memories.map((m) => m.memoryId);
    const indexA = ids.indexOf(a.id);
    const indexB = ids.indexOf(b.id);
    expect(Math.abs(indexA - indexB)).toBe(1);
  });

  it("予算に両方載らない場合、ペアごと落とす（片方だけを残さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);
    // maxMemoryChars は a.digest（5文字）だけなら収まるが、a+b（5+20=25文字）は収まらない大きさにする。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 10 },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(result.omitted).toContainEqual({ kind: "budget_dropped", count: 2, countKind: "exact" });
  });

  it("予算が十分ならペアは両方とも残る", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 100 },
    });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);
  });
});

describe("recall() — 被覆不変条件（docs/recall.md §5）", () => {
  it("groups の総和は totalInScope と一致する", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "user-1" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "user-1" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "user-2" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: null }));
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const result = await runtime.recall(ctx, {});
    const sumOfGroups = result.index.groups.reduce((sum, g) => sum + g.count, 0);
    expect(sumOfGroups).toBe(result.index.totalInScope);
    expect(result.index.totalInScope).toBe(4);
  });
});

describe("recall() — explain.stages（roadmap.md 段階5）", () => {
  it("happy path ではすべての段が executed:true になる", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const byStage = new Map(result.explain.stages.map((s) => [s.stage, s.executed]));
    expect(byStage.get("scope")).toBe(true);
    expect(byStage.get("candidate_generation")).toBe(true);
    expect(byStage.get("rescore")).toBe(true);
    expect(byStage.get("contradiction_resolution")).toBe(true);
    expect(byStage.get("budget_truncation")).toBe(true);
    expect(byStage.get("index_band")).toBe(true);
    expect(byStage.get("record")).toBe(true);
  });
});

describe("recall() — 段6: 記録（必須の段。ADR 0008）", () => {
  it("recallId が発行され、observe({kind:'memory_usage'}) から参照できる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.recallId).toBeTruthy();

    const usageResult = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: result.recallId,
      usedMemoryIds: [memory.id],
    });
    expect(usageResult.memoryIds).toEqual([memory.id]);
  });
});

describe("recall() — usage（docs/recall.md §6: 計測と強制を混同しない）", () => {
  it("budget を渡さない場合は usage.share が無く、切り詰めも起きない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.usage.share).toBeUndefined();
    expect(result.usage.counter).toBe("heuristic");
  });

  it("budget を渡すと usage.share が「予算の対象（memories tier）が予算のどれだけを使ったか」になる", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0], budget: { maxMemoryChars: 1000 } });
    expect(result.usage.share).toBeDefined();
    // 分子は memories tier だけ = chars から目次帯を除いた分。
    // （以前は chars 全体を分子にしていたため、目次帯のぶんだけ share が水増しされていた。）
    expect(result.usage.share).toBeCloseTo(
      (result.usage.chars - result.usage.indexChars) / 1000,
      10,
    );
    expect(result.usage.indexChars).toBeGreaterThan(0);
  });

  /**
   * ⭐ 目次帯が budget の対象外であることと、share が割合として成立することの歯。
   *
   * 目次帯を budget の対象にしない理由は ADR 0008 の芯にある——「0件でも何が在るかは言える」
   * という目次帯の唯一の存在理由が、呼び出し側の渡した数字ひとつで消えてはならない。
   * その帰結として、**目次帯より小さい budget を渡しても目次帯は削られない**。
   *
   * このとき share の分子に目次帯を含めていると 1 を超える（実際に 248% が観測されていた）。
   * 「予算の何割を使ったか」と「全体でいくらかかったか」は別の問いであり、
   * 1つの数で両方に答えようとするとどちらかが嘘になる。
   */
  it("目次帯より小さい budget でも、目次帯は削られず、share は 1 を超えない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0], budget: { maxMemoryChars: 1 } });

    // 目次帯は予算の外なので、予算が 1 文字でも残っている。
    expect(result.usage.indexChars).toBeGreaterThan(1);
    // 全量は予算を超える（目次帯のぶん）——これは仕様どおりであり、隠さない。
    expect(result.usage.chars).toBeGreaterThan(1);
    // だが share は「予算の対象がどれだけ使ったか」なので 1 を超えない。
    expect(result.usage.share).toBeLessThanOrEqual(1);
  });
});

describe("recall() — D5: 既定で provenance.kind='inferred' を含める。除外オプション", () => {
  it("既定では inferred な Memory も返る", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      provenance: {
        kind: "inferred",
        model: "test-model",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: [] },
        confidence: 0.9,
      },
    });
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toHaveLength(1);
  });

  it("excludeProvenanceKinds: ['inferred'] を渡すと除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      provenance: {
        kind: "inferred",
        model: "test-model",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: [] },
        confidence: 0.9,
      },
    });
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["inferred"],
    });
    expect(result.memories).toHaveLength(0);
  });
});

describe("recall() — status ゲート（段1と同じ status IN ('active','contested')）", () => {
  const excludedStatuses: MemoryStatus[] = ["superseded", "archived", "forgotten"];
  for (const status of excludedStatuses) {
    it(`status='${status}' の Memory は ANN 候補に現れない`, async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0], { status });
      const result = await runtime.recall(ctx, { vector: [1, 0] });
      expect(result.memories).toEqual([]);
    });
  }
});

describe("recall() — RecallQuerySchema による入力検証", () => {
  it("limit が非正の場合は zod のエラーで拒否する", async () => {
    const { runtime } = buildRuntime();
    await expect(runtime.recall(ctx, { limit: 0 })).rejects.toThrow();
  });

  it("excludeProvenanceKinds に未知の値を渡すと拒否する", async () => {
    const { runtime } = buildRuntime();
    await expect(
      // @ts-expect-error 意図的に不正な値を渡す
      runtime.recall(ctx, { excludeProvenanceKinds: ["fabricated"] }),
    ).rejects.toThrow();
  });
});
