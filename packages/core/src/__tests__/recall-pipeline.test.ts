import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Ctx } from "../ctx.js";
import type { TokenCounter } from "../interfaces/token-counter.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { heuristicTokenCounter } from "../heuristic-token-counter.js";
import type { Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { Provenance } from "../provenance.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { RecallOutputValidationError } from "../recall-output-validation.js";
import type { RecallOutputValidationMode } from "../recall-output-validation.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。 */

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

function buildRuntime(
  overrides: { tokenCounter?: TokenCounter; outputValidation?: RecallOutputValidationMode } = {},
) {
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
    tokenCounter: overrides.tokenCounter,
    outputValidation: overrides.outputValidation,
  });
  return { runtime, stores };
}

/** `ann_unreached` の歯のための `VectorStore` の薄いラッパー。`FakeVectorStore` は `limit` まで律儀に返すので、「scope にもっと候補があるのに ANN が少ない件数しか返さない」状況を、`search` の返り件数を後から切り詰めて作る。 */
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

  deleteAcrossSpaces(
    ...args: Parameters<VectorStore["deleteAcrossSpaces"]>
  ): ReturnType<VectorStore["deleteAcrossSpaces"]> {
    return this.inner.deleteAcrossSpaces(...args);
  }
}

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

  it("空白だけの text は ZodError にならず、'empty_query_content' で skip される（RecallQuery.text の TSDoc、ADR 0593）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { text: "   " });
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "empty_query_content",
    });
    expect(result.memories).toEqual([]);
  });

  it("embedding provider が失敗すると 'embedding_provider_unavailable' で skip される", async () => {
    const { runtime, stores } = buildRuntime();
    stores.embeddingProvider.shouldFail = true;
    const result = await runtime.recall(ctx, { text: "何かのクエリ" });
    // 任意欄 `cause`（原因の種類）が付くので、既存の3欄だけを objectContaining で見る。
    expect(result.omitted).toContainEqual(
      expect.objectContaining({
        kind: "stage_skipped",
        stage: "candidate_generation",
        reason: "embedding_provider_unavailable",
      }),
    );
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
      scopeRelation: "outside_scope",
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
      scopeRelation: "outside_scope",
      count: 3,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      scopeRelation: "outside_scope",
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
      scopeRelation: "outside_scope",
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

    // association: null: この歯は over_limit だけを検査する。limit の外に落ちた候補は連想の対象にもなりうるので止める。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
      association: null,
    });
    expect(result.memories).toHaveLength(1);
    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "rescore",
      count: 1,
      countKind: "exact",
    });
  });
});

describe("recall() — omitted.kind = 'ann_truncated'（docs/recall.md §3、ADR 0069）", () => {
  // この describe の契約: ann_truncated は「k' に達し、かつ損失が起こりえたとき」だけ付く（窓が埋まっただけでは損したかを言えない、ADR 0069）。1本目は以前の歯と同じ状況を作って鳴らないことを固定する。
  it("k' に達しても、窓の外が top-k へ入れないと証明できたら鳴らない（ADR 0069）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // 返った1件は similarity=1.0 で非 similarity 項が全部上界に張り付いている（R = 1 / (1 × 1) = 1）ので、窓の外は原理的に抜けず沈黙する。
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1, overFetchFactor: 1 });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(false);
  });

  it("窓の外が top-k へ入りえたら、safetyRatio と前提を付けて鳴る（ADR 0069）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // どの候補も持たないタグをクエリへ足すと上界が 1.1 に上がり R ≈ 0.909 < 1: 窓の外にこのタグを持つ記憶が居たら抜かれていた、という札になる。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 1,
      tags: ["どの候補も持っていないタグ"],
    });
    const found = result.omitted.find((o) => o.kind === "ann_truncated");
    if (found === undefined || found.kind !== "ann_truncated") {
      throw new Error("ann_truncated が積まれていない");
    }
    expect(found.certainty).toBe("loss_possible");
    expect(found.countKind).toBe("unknown");
    expect(found.safetyRatio).toBeLessThan(1);
    expect(found.safetyRatio).toBeCloseTo(1 / 1.1, 6);
    expect(found.assumptions?.join(" ")).toContain("decay");
    expect(found.assumptions?.join(" ")).toContain("strength");
  });

  it("候補が k' 未満ならフルスキャンと同精度になり ann_truncated は付かない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, overFetchFactor: 4 });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(false);
  });

  it("k' は少なくとも 1——limit × overFetchFactor が 0.5 未満でも候補を1件取り込む（RecallQuery.overFetchFactor の TSDoc、ADR 0593）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await createEmbeddedMemory(stores, [1, 0]);

    // round(1 × 0.1) = 0。下限が無ければ store の search に limit 0 が渡り、何も取り込まない。
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1, overFetchFactor: 0.1 });
    expect(result.memories.map((m) => m.memoryId)).toEqual([memory.id]);
  });
});

describe("recall() — omitted.kind = 'ann_unreached'（ADR 0025 の実測、ADR 0026 の決定、ADR 0193 が発火条件を拡張）", () => {
  it("歯A（鳴る側）: scope に候補が多くあるのに ANN が eligible 未満しか返さないと ann_unreached が付く", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(2);
    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "warning",
    });
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

  it("🔴 歯C（ADR 0193、2026-09-17 に挙動が変わった）: 窓が満杯（hits == k'）でも、scope にまだ見えていない候補が残っていれば ann_truncated と ann_unreached は同時に鳴る", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // 鳴る側になる形（どの候補も持たないタグをクエリへ足す）で作る。ann_truncated（窓の外は証明できるか）と ann_unreached（索引は scope を拾いきったか）は別の問いなので、同時に立ってよい。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 1,
      tags: ["どの候補も持っていないタグ"],
    });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(true);
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(true);
    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "info",
    });
  });

  it("⭐ 歯D（鳴ってはいけない側）: 窓が満杯でも scope の候補を全部拾いきっていれば ann_unreached は鳴らない（ADR 0193）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    // eligible=1 == hits=1 なので scope に見えていない候補は無い。主題は ann_unreached が鳴らないことなので、ann_truncated は鳴る側の形で作る。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 1,
      tags: ["どの候補も持っていないタグ"],
    });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(true);
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
  });

  it("歯E（severity: 'info'）: 窓が満杯（hits == kPrime）で、eligible > kPrime という構造だけで鳴っているときは info", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 41; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "info",
    });
  });

  it("歯F（severity: 'warning'）: ANN 窓が到達可能な下限に届かなかったときは warning", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(3);
    for (let i = 0; i < 10; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "warning",
    });
  });
});

describe("recall() — explain.stages[candidate_generation(ann)].detail.annReturnedFewerThanReachable（ADR 0285 / Issue #671 続報）", () => {
  // 他テナントの near-duplicate が HNSW の候補枠 k' を埋めると、ANN は scope 内の候補を1件も返さず、`ann_unreached` だけでは全滅と正常時を区別できない。`Omission` union は変えず、`explain.stages` の ann trace の detail キーだけを検査する。
  // 判定は `annHits.length < min(kPrime, reachableLowerBound)`（`reachableLowerBound = max(0, eligible - filteredDecayed.count)`）。decayed が1件でもあれば判定しない形は本番で恒久的に沈黙するので、下限で判定する。
  // 引き受けた負債: 下限は「未索引かつ decayed」の分だけ真の母数より小さくなりうるので、その分の取りこぼしは見逃す（「見逃しの対照」が固定する）。`excludeProvenanceKinds` 指定時は下限の保証が崩れるので判定しない。

  function findAnnDetail(result: RecallResult) {
    const trace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.channel === "ann",
    );
    return trace?.detail;
  }

  it("陽性1（他テナント占拠を模す）: ANN が0件を返し、分母が0件より多いとき、annReturnedFewerThanReachable: true が付く", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(0);
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toEqual([]);
    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "warning",
    });
    expect(findAnnDetail(result)).toMatchObject({
      annReturnedFewerThanReachable: true,
      annReachableLowerBound: 3,
    });
  });

  it("陽性2（天井打ち切りを模す）: ANN が kPrime 未満・分母未満の件数で打ち切られたとき、annReturnedFewerThanReachable: true が付く", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(2);
    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const detail = findAnnDetail(result);
    expect(detail).toMatchObject({
      hits: 2,
      annReturnedFewerThanReachable: true,
      annReachableLowerBound: 5,
    });
  });

  it("陽性3（decayed が一部あっても下限で名乗る）: ready 10件中3件が decayed でも、下限(7) > hits なら annReturnedFewerThanReachable: true が付く", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(2);
    // ready 10件のうち3件を decayed にする: reachableLowerBound = 10 - 3 = 7。
    for (let i = 0; i < 7; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], {
        decayFloorAt: new Date("2020-01-01T00:00:00.000Z"),
      });
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const detail = findAnnDetail(result);
    expect(detail).toMatchObject({
      hits: 2,
      annReturnedFewerThanReachable: true,
      annReachableLowerBound: 7,
    });
  });

  it("偽陽性の対照（鳴ってはいけない側）: scope 内の埋め込みがある行が全て decayed のとき、annReturnedFewerThanReachable は付かない", async () => {
    const { runtime, stores } = buildRuntime();
    // ANN は正しく0件を返す（探して何も無かった）。下限は 0 なので鳴らない。
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], {
        decayFloorAt: new Date("2020-01-01T00:00:00.000Z"),
      });
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toEqual([]);
    const detail = findAnnDetail(result);
    expect(Object.keys(detail ?? {})).not.toContain("annReturnedFewerThanReachable");
    expect(Object.keys(detail ?? {})).not.toContain("annReachableLowerBound");
  });

  it("見逃しの対照（既知の限界。鳴らないことを固定する）: 未索引かつ decayed の行があると、下限が真の母数より小さくなり、実際の取りこぼしを見逃しうる", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(2);
    // pending かつ decayed の1件は vectorStore へ upsert しない。下限（2）は真の母数（3）より1小さく、取りこぼし（返せたのは2件）があっても鳴らない。偶然の赤ではなく、下限判定が引き受けた既知の限界として固定する。
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date("2020-01-01T00:00:00.000Z") }),
    );
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }
    await createEmbeddedMemory(stores, [1, 0], {
      decayFloorAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const detail = findAnnDetail(result);
    expect(detail).toMatchObject({ hits: 2 });
    expect(Object.keys(detail ?? {})).not.toContain("annReturnedFewerThanReachable");
    expect(Object.keys(detail ?? {})).not.toContain("annReachableLowerBound");
  });

  it("揃っていない次元の対照（鳴ってはいけない側）: excludeProvenanceKinds が指定されているとき、annReturnedFewerThanReachable は付かない", async () => {
    const { runtime, stores } = buildRuntime();
    // imported を丸ごと除外するクエリ: ANN は正しく0件を返すが、`excludeProvenanceKinds` は `ScopeAggregate` に届かず、集約側からは絞りが見えない。
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["imported"],
    });
    expect(result.memories).toEqual([]);
    const detail = findAnnDetail(result);
    expect(Object.keys(detail ?? {})).not.toContain("annReturnedFewerThanReachable");
  });

  it("やりすぎの対照A（鳴ってはいけない側）: 正常時（ANN が分母まで拾いきる）にはキー自体が付かない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toHaveLength(1);
    const detail = findAnnDetail(result);
    // `false` ではなくキーの不在を確かめる: `{ annReturnedFewerThanReachable: undefined }` という壊れた実装も通ってしまうため。
    expect(Object.keys(detail ?? {})).not.toContain("annReturnedFewerThanReachable");
    expect(Object.keys(detail ?? {})).not.toContain("annReachableLowerBound");
  });

  it("やりすぎの対照B（鳴ってはいけない側）: 分母が0件（scope が空）のときもキー自体が付かない", async () => {
    const { runtime } = buildRuntime();
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toEqual([]);
    const detail = findAnnDetail(result);
    expect(Object.keys(detail ?? {})).not.toContain("annReturnedFewerThanReachable");
  });
});

describe("recall() — omitted.kind = 'unit_assembly_dropped'（ADR 0043）", () => {
  // ここで測るのは、`contested` を作る主体が入ったときに機構が黙らないという契約。「候補が単位から漏れること」を正しい振る舞いとして固定せず、漏れたときに黙らないことだけを固定する。

  /** 一対一が破れた壊れたデータ（contested の鎖 A→B→C）を作る。B が消費済みになり、B の同伴として取られた C はどの単位にも入らない。 */
  async function seedBrokenChain(stores: ReturnType<typeof createFakeRuntimeStores>) {
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "C" }),
    );
    const b = await createEmbeddedMemory(stores, [0.9, 0.1], {
      status: "contested",
      digest: "B",
      contestedWithId: c.id,
    });
    const a = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      digest: "A",
      contestedWithId: b.id,
    });
    return { a, b, c };
  }

  it("🔴 一対一が破れて候補が単位から漏れたら、omitted に出す（黙らない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { c } = await seedBrokenChain(stores);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(c.id);
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it("⚠ 鳴ってはいけない側: 一対一が破れていなければ出ない（対向ペア）", async () => {
    // 件数を 2 対 1 と違える: 同じ件数で作ると単位の取り違えが出力を変えない。
    const { runtime, stores } = buildRuntime();
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "B" }),
    );
    await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      digest: "A",
      contestedWithId: b.id,
    });
    await createEmbeddedMemory(stores, [0.8, 0.2], { digest: "単独" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(result.memories.length).toBe(3);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });

  it("⚠ 鳴ってはいけない側: contested が1件も無い普通の recall でも出ない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "普通1" });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "普通2" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });
});

describe("recall() — budget_dropped の countKind は単位の網羅性から決まる（ADR 0045）", () => {
  it("🔴 単位が候補を網羅していないとき、budget_dropped は 'exact' を名乗らない", async () => {
    // contested の鎖 A→B→C（一対一が破れた壊れたデータ）。C は埋め込みが無く候補にならず、単位は A から始まって B を消費するので C はどの単位にも入らない。固定するのは、漏れているときに 'exact' と名乗らない正直さであり、漏れること自体を正しい振る舞いとして固定するものではない。
    const { runtime, stores } = buildRuntime();
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "C" }),
    );
    const b = await createEmbeddedMemory(stores, [0.9, 0.1], {
      status: "contested",
      digest: "B",
      contestedWithId: c.id,
    });
    await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      digest: "A",
      contestedWithId: b.id,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 1 },
    });
    const dropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(dropped).toBeDefined();
    expect(dropped).toMatchObject({ count: 2 });
    expect(dropped).toMatchObject({ countKind: "unknown" });
  });

  it("⚠ 鳴ってはいけない側: 単位が候補を網羅していれば 'exact' のまま", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "A".repeat(30) });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "B".repeat(30) });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 1 },
    });
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 2,
      countKind: "exact",
    });
  });
});

describe("recall() — omitted.kind = 'score_not_comparable'（ADR 0044）", () => {
  // NaN を作る経路は2通りある。ここでは `halfLifeHours = 0` かつ経過時間ちょうど 0（`0.5 ** (0 / 0)` が NaN）を使う。`halfLifeHours: 0` は `decayFloorAt === recordedAt === NOW` になり、既定では忘却ゲートが先に落とすので、`includeFullyDecayed: true` でゲートを無効化して段2まで届かせる。

  it("比較が決まらない候補は score_not_comparable に出る（件数と countKind つき）", async () => {
    const { runtime, stores } = buildRuntime();
    // 件数を 1 対 2 と違える: 同数だと取り違えが観測できない。
    await createEmbeddedMemory(stores, [1, 0], { digest: "壊れた", halfLifeHours: 0 });
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常1" });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "正常2" });

    // association: null: 連想の候補選定は score_not_comparable を経由しないので、この歯の対象外の効果を持ち込まないよう止める。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      includeFullyDecayed: true,
      association: null,
    });
    const digests = result.memories.map((m) => m.digest);
    expect(digests).toContain("正常1");
    expect(digests).toContain("正常2");
    expect(digests).not.toContain("壊れた");

    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
  });

  it("🔴 三分割は網羅である: scored = passed + below_threshold + score_not_comparable", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "壊れた", halfLifeHours: 0 });
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常" });

    // includeFullyDecayed: true の理由は上の describe 冒頭を参照。association: null は、連想が「壊れた」記憶を拾い直すと score_not_comparable から取り下げられ、段2の三分割と件数が一致しなくなるため。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      scoreThreshold: 0,
      includeFullyDecayed: true,
      association: null,
    });
    const rescore = result.explain.stages.find((st) => st.stage === "rescore");
    const detail = rescore?.detail as
      { scored: number; passedThreshold: number; notComparable: number } | undefined;
    const below = result.omitted.find((o) => o.kind === "below_threshold")?.count ?? 0;
    const notComparable = result.omitted.find((o) => o.kind === "score_not_comparable")?.count ?? 0;

    expect(detail?.scored).toBe(2);
    expect(detail?.notComparable).toBe(notComparable);
    expect(detail!.passedThreshold + below + notComparable).toBe(detail!.scored);
  });

  it("⭐ ゼロベクトルの記憶が混ざると score_not_comparable が出る（ADR 0040 と繋がる端）", async () => {
    // Fake がゼロベクトルに NaN を返す、本物の pgvector と同じ経路。上の歯の `halfLifeHours = 0` とは別の NaN の作られ方で、どちらも残す。
    const { runtime, stores } = buildRuntime();
    // ⚠ 件数を 1 対 2 と違える。
    await createEmbeddedMemory(stores, [0, 0], { digest: "ゼロベクトル" });
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常1" });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "正常2" });

    // scoreThreshold: 0 で測る: 既定の 0.1 では差が観測できない。
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, scoreThreshold: 0 });
    const digests = result.memories.map((m) => m.digest);
    expect(digests).toContain("正常1");
    expect(digests).toContain("正常2");
    expect(digests).not.toContain("ゼロベクトル");

    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
  });

  it("⚠ 鳴ってはいけない側: 正常な候補だけなら score_not_comparable は出ない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常1" });
    await createEmbeddedMemory(stores, [0.5, 0.5], { digest: "正常2" });

    // 既定の閾値と 0 の両方で鳴らないことを見る（差が出るのは 0 側なので、両方要る）。
    for (const scoreThreshold of [undefined, 0]) {
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 10,
        ...(scoreThreshold === undefined ? {} : { scoreThreshold }),
      });
      expect(result.omitted.some((o) => o.kind === "score_not_comparable")).toBe(false);
    }
  });
});

describe("recall() — 次元の違うクエリベクトルは比較不能として扱う（Issue #867 / 案B）", () => {
  // 長さの不一致は「比較不能」として扱う: `FakeVectorStore` は長さが違う2本に NaN を返し、段2の三分割が `omitted.score_not_comparable` に数える（Postgres は pgvector のエラーになるため、adapter 間で挙動を揃える）。

  it("短いクエリ（[1,2]）は score_not_comparable に数えられ、memories は空", async () => {
    const { runtime, stores } = buildRuntime();
    // 空間の宣言（dimensions: 2）とは別に、保存側と問い合わせ側の長さの不一致そのものを再現する。
    await createEmbeddedMemory(stores, [1, 0, 0], { digest: "保存データ" });

    const result = await runtime.recall(ctx, { vector: [1, 2], limit: 10, scoreThreshold: 0 });
    expect(result.memories).toEqual([]);
    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
  });

  it("長いクエリ（[1,2,3,4]）も score_not_comparable に数えられ、memories は空", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0, 0], { digest: "保存データ" });

    const result = await runtime.recall(ctx, {
      vector: [1, 2, 3, 4],
      limit: 10,
      scoreThreshold: 0,
    });
    expect(result.memories).toEqual([]);
    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
  });

  it("⚠ 鳴ってはいけない側: 長さが一致するクエリは普通に score_not_comparable なしでヒットする", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0, 0], { digest: "保存データ" });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 10, scoreThreshold: 0 });
    expect(result.memories.map((m) => m.digest)).toContain("保存データ");
    expect(result.omitted.some((o) => o.kind === "score_not_comparable")).toBe(false);
  });
});

describe("recall() — provenanceKind（roadmap.md §5.5 のオーナー回答の条件）", () => {
  // fixture は kind をすべて違える: 同じ kind を並べると、その Memory の kind ではなくどれか1つの kind を全件に配る実装を通してしまう。

  it("ANN 経由の候補は、その Memory 自身の provenance.kind を名乗る（候補ごとに違う値になる）", async () => {
    const { runtime, stores } = buildRuntime();
    const stated = await createEmbeddedMemory(stores, [1, 0], {
      digest: "stated の記憶",
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });
    const inferred = await createEmbeddedMemory(stores, [0.99, 0.01], {
      digest: "inferred の記憶",
      provenance: {
        kind: "inferred",
        model: "gpt-4o-mini",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: ["obs-1"] },
        confidence: 0.7,
      },
    });
    const imported = await createEmbeddedMemory(stores, [0.98, 0.02], {
      digest: "imported の記憶",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const kindById = new Map(result.memories.map((m) => [m.memoryId, m.provenanceKind]));
    expect(kindById.get(stated.id)).toBe("stated");
    expect(kindById.get(inferred.id)).toBe("inferred");
    expect(kindById.get(imported.id)).toBe("imported");
  });

  it("同伴取得（mandatory_companion）でも、対向の Memory 自身の kind を名乗る", async () => {
    // 同伴側は ANN を通らず getMany で拾われる別経路である。
    // ここを別に見ないと、「ANN 経由だけ正しく、同伴側は主の kind を配る」実装が通る。
    const { runtime, stores } = buildRuntime();
    const companion = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        status: "contested",
        digest: "B".repeat(20),
        provenance: {
          kind: "inferred",
          model: "gpt-4o-mini",
          promptVersion: "v1",
          basis: { memoryIds: [], observationIds: ["obs-1"] },
          confidence: 0.4,
        },
      }),
    );
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "A".repeat(5),
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    expect(returnedCompanion?.provenanceKind).toBe("inferred");
    expect(returnedOwner?.provenanceKind).toBe("stated");
  });

  it("usage は provenanceKind を数に入れない（測るのは digest と目次帯だけ）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "digest-1",
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });
    await createEmbeddedMemory(stores, [0.99, 0.01], { digest: "digest-22" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const digestChars = result.memories.reduce((sum, m) => sum + m.digest.length, 0);
    expect(result.memories).toHaveLength(2);
    expect(result.usage.byTier.digest).toBe(digestChars);
    expect(result.usage.chars).toBe(digestChars + result.usage.indexChars);
  });
});

describe("recall() — speaker/subjectId（Issue #579 案D、ADR 0289）", () => {
  // 常に値か null を入れる: キー自体が無い/undefined になる経路が無いことを `Object.hasOwn` と `not.toBeUndefined()` で固定する（`toEqual` は undefined のキーと無いキーを同じに扱う）。

  it("stated かつ speaker が在れば、その値をそのまま名乗る（ANN 経由）", async () => {
    const { runtime, stores } = buildRuntime();
    const stated = await createEmbeddedMemory(stores, [1, 0], {
      digest: "speaker あり",
      provenance: {
        kind: "stated",
        sourceObservationId: "obs-1",
        at: NOW.toISOString(),
        speaker: "田中さん",
      },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === stated.id);
    expect(m).toBeDefined();
    expect(Object.hasOwn(m!, "speaker")).toBe(true);
    expect(m!.speaker).not.toBeUndefined();
    expect(m!.speaker).toBe("田中さん");
  });

  it("stated だが speaker が無ければ null（キー自体は在る）", async () => {
    const { runtime, stores } = buildRuntime();
    const stated = await createEmbeddedMemory(stores, [1, 0], {
      digest: "speaker なし",
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === stated.id);
    expect(m).toBeDefined();
    expect(Object.hasOwn(m!, "speaker")).toBe(true);
    expect(m!.speaker).not.toBeUndefined();
    expect(m!.speaker).toBeNull();
  });

  it("inferred は speaker を持ちようが無いので null（StatedProvenance にしか speaker が無い）", async () => {
    const { runtime, stores } = buildRuntime();
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      digest: "inferred",
      provenance: {
        kind: "inferred",
        model: "gpt-4o-mini",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: ["obs-1"] },
        confidence: 0.7,
      },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === inferred.id);
    expect(Object.hasOwn(m!, "speaker")).toBe(true);
    expect(m!.speaker).not.toBeUndefined();
    expect(m!.speaker).toBeNull();
  });

  it("consolidated は speaker を持ちようが無いので null", async () => {
    const { runtime, stores } = buildRuntime();
    const consolidated = await createEmbeddedMemory(stores, [1, 0], {
      digest: "consolidated",
      provenance: { kind: "consolidated", sources: ["mem-a", "mem-b"] },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === consolidated.id);
    expect(Object.hasOwn(m!, "speaker")).toBe(true);
    expect(m!.speaker).not.toBeUndefined();
    expect(m!.speaker).toBeNull();
  });

  it("kind !== 'stated' の provenance がたまたま speaker という名のプロパティを持っていても無視する（kind を見ずに provenance.speaker を読む実装を拒む）", async () => {
    // 将来どこかの provenance 枝が偶然 speaker という名を持っても null を返すことを、型を迂回して構築した fixture で先取りして固定する（今日は StatedProvenance 以外は speaker を持たず、kind を見ずに読む実装を検出できない）。
    const { runtime, stores } = buildRuntime();
    const leaked = await createEmbeddedMemory(stores, [1, 0], {
      digest: "imported だが speaker という名の余計なプロパティを持つ",
      provenance: {
        kind: "imported",
        batchId: "fixture",
        speaker: "漏れてはいけない値",
      } as unknown as NewMemory["provenance"],
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === leaked.id);
    expect(Object.hasOwn(m!, "speaker")).toBe(true);
    expect(m!.speaker).not.toBeUndefined();
    expect(m!.speaker).toBeNull();
  });

  it("subjectId が在ればその値、null ならそのまま null、Memory 側で undefined でも null に揃える", async () => {
    const { runtime, stores } = buildRuntime();
    const withSubject = await createEmbeddedMemory(stores, [1, 0], {
      digest: "subject あり",
      subjectId: "user:a",
    });
    const nullSubject = await createEmbeddedMemory(stores, [0.99, 0.01], {
      digest: "subject null",
      subjectId: null,
    });
    const undefinedSubject = await createEmbeddedMemory(stores, [0.98, 0.02], {
      digest: "subject undefined",
    });
    // `FakeMemoryStore.createMemory` は subjectId を null に正規化するので、渡すだけでは `recall-runtime.ts` の `?? null` 防御を通らない。store の行そのもの（`liveRowForTest`）を書き換える（`createMemory` の返り値は写しで、書き換えても届かない）。
    stores.memoryStore.liveRowForTest(ctx, undefinedSubject.id)!.subjectId = undefined;
    // 前提の明示: Fake が `get` で undefined を null に揃えていないこと。
    expect((await stores.memoryStore.get(ctx, undefinedSubject.id))!.subjectId).toBeUndefined();

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const byId = new Map(result.memories.map((m) => [m.memoryId, m]));

    const a = byId.get(withSubject.id)!;
    expect(Object.hasOwn(a, "subjectId")).toBe(true);
    expect(a.subjectId).not.toBeUndefined();
    expect(a.subjectId).toBe("user:a");

    const b = byId.get(nullSubject.id)!;
    expect(Object.hasOwn(b, "subjectId")).toBe(true);
    expect(b.subjectId).not.toBeUndefined();
    expect(b.subjectId).toBeNull();

    const c = byId.get(undefinedSubject.id)!;
    expect(Object.hasOwn(c, "subjectId")).toBe(true);
    expect(c.subjectId).not.toBeUndefined();
    expect(c.subjectId).toBeNull();
  });

  it("同伴取得（mandatory_companion）でも speaker/subjectId は対向の Memory 自身の値を名乗る", async () => {
    const { runtime, stores } = buildRuntime();
    const companion = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        status: "contested",
        digest: "B".repeat(20),
        subjectId: "user:companion",
        provenance: {
          kind: "inferred",
          model: "gpt-4o-mini",
          promptVersion: "v1",
          basis: { memoryIds: [], observationIds: ["obs-1"] },
          confidence: 0.4,
        },
      }),
    );
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "A".repeat(5),
      subjectId: "user:owner",
      provenance: {
        kind: "stated",
        sourceObservationId: "obs-1",
        at: NOW.toISOString(),
        speaker: "本人",
      },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id)!;
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id)!;

    expect(returnedCompanion.retrievedVia).toBe("mandatory_companion");
    expect(Object.hasOwn(returnedCompanion, "speaker")).toBe(true);
    expect(returnedCompanion.speaker).toBeNull(); // inferred には speaker が無い
    expect(Object.hasOwn(returnedCompanion, "subjectId")).toBe(true);
    expect(returnedCompanion.subjectId).toBe("user:companion");

    expect(Object.hasOwn(returnedOwner, "speaker")).toBe(true);
    expect(returnedOwner.speaker).toBe("本人");
    expect(Object.hasOwn(returnedOwner, "subjectId")).toBe(true);
    expect(returnedOwner.subjectId).toBe("user:owner");
  });

  it("usage.chars は speaker/subjectId を数に入れない（ADR 0035 §2 の実測を踏襲）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "digest-1",
      subjectId: "user:with-a-fairly-long-subject-id-value",
      provenance: {
        kind: "stated",
        sourceObservationId: "obs-1",
        at: NOW.toISOString(),
        speaker: "とても長い名前の話者ラベルをここに置いてみる",
      },
    });
    await createEmbeddedMemory(stores, [0.99, 0.01], { digest: "digest-22" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const digestChars = result.memories.reduce((sum, m) => sum + m.digest.length, 0);
    expect(result.memories).toHaveLength(2);
    expect(result.usage.byTier.digest).toBe(digestChars);
    expect(result.usage.chars).toBe(digestChars + result.usage.indexChars);
  });
});

describe("recall() — recordedAt/occurredAt（Issue #691 の子、Issue #702、ADR 0298）", () => {
  // 常に値か null を入れる: キー自体が無い/undefined になる経路が無いことを `Object.hasOwn` と `not.toBeUndefined()` で固定する（`toEqual` は undefined のキーと無いキーを同じに扱う）。

  it("recordedAt は Memory.recordedAt をそのまま名乗る（Memory 側は必須なので常に値）", async () => {
    const { runtime, stores } = buildRuntime();
    const recordedAt = new Date("2026-05-20T00:00:00.000Z");
    const memory = await createEmbeddedMemory(stores, [1, 0], {
      digest: "recordedAt あり",
      recordedAt,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === memory.id);
    expect(m).toBeDefined();
    expect(Object.hasOwn(m!, "recordedAt")).toBe(true);
    expect(m!.recordedAt).not.toBeUndefined();
    expect(m!.recordedAt).toEqual(recordedAt);
  });

  it("occurredAt が在れば、その値をそのまま名乗る", async () => {
    const { runtime, stores } = buildRuntime();
    const occurredAt = new Date("2026-05-01T00:00:00.000Z");
    const memory = await createEmbeddedMemory(stores, [1, 0], {
      digest: "occurredAt あり",
      occurredAt,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === memory.id);
    expect(m).toBeDefined();
    expect(Object.hasOwn(m!, "occurredAt")).toBe(true);
    expect(m!.occurredAt).not.toBeUndefined();
    expect(m!.occurredAt).toEqual(occurredAt);
  });

  it("occurredAt が無ければ null（キー自体は在る。newMemory の既定どおり occurredAt: null）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await createEmbeddedMemory(stores, [1, 0], { digest: "occurredAt なし" });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === memory.id);
    expect(Object.hasOwn(m!, "occurredAt")).toBe(true);
    expect(m!.occurredAt).not.toBeUndefined();
    expect(m!.occurredAt).toBeNull();
  });

  it("Memory.occurredAt が undefined でも null に揃える（subjectId と同じ防御）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await createEmbeddedMemory(stores, [1, 0], { digest: "occurredAt undefined" });
    // `occurredAt` も同じ手口: `liveRowForTest` で行そのものを書き換えて本当に undefined にする。
    stores.memoryStore.liveRowForTest(ctx, memory.id)!.occurredAt = undefined;
    // 前提の明示: Fake が undefined を null に揃えていないこと。
    expect((await stores.memoryStore.get(ctx, memory.id))!.occurredAt).toBeUndefined();

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const m = result.memories.find((x) => x.memoryId === memory.id);
    expect(Object.hasOwn(m!, "occurredAt")).toBe(true);
    expect(m!.occurredAt).not.toBeUndefined();
    expect(m!.occurredAt).toBeNull();
  });

  it("recordedAt が異なる2件は、区別できる値を持つ（『後で訂正された』を読むための前提。Issue #691 背景）", async () => {
    const { runtime, stores } = buildRuntime();
    const earlier = new Date("2026-05-01T10:00:00.000Z");
    const later = new Date("2026-05-01T10:05:00.000Z");
    const first = await createEmbeddedMemory(stores, [1, 0], {
      digest: "来週の定例会議は金曜日にある。",
      recordedAt: earlier,
    });
    const second = await createEmbeddedMemory(stores, [1, 0], {
      digest: "定例会議は水曜日に移動する必要がある。",
      recordedAt: later,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const m1 = result.memories.find((x) => x.memoryId === first.id)!;
    const m2 = result.memories.find((x) => x.memoryId === second.id)!;
    expect(m1.recordedAt).toEqual(earlier);
    expect(m2.recordedAt).toEqual(later);
    expect(m2.recordedAt!.getTime()).toBeGreaterThan(m1.recordedAt!.getTime());
  });

  it("同伴取得（mandatory_companion）でも recordedAt/occurredAt は対向の Memory 自身の値を名乗る", async () => {
    const { runtime, stores } = buildRuntime();
    const companionRecordedAt = new Date("2026-04-01T00:00:00.000Z");
    const companion = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        status: "contested",
        digest: "B".repeat(20),
        recordedAt: companionRecordedAt,
        provenance: {
          kind: "inferred",
          model: "gpt-4o-mini",
          promptVersion: "v1",
          basis: { memoryIds: [], observationIds: ["obs-1"] },
          confidence: 0.4,
        },
      }),
    );
    const ownerRecordedAt = new Date("2026-04-02T00:00:00.000Z");
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "A".repeat(5),
      recordedAt: ownerRecordedAt,
      provenance: {
        kind: "stated",
        sourceObservationId: "obs-1",
        at: NOW.toISOString(),
        speaker: "本人",
      },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id)!;
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id)!;

    expect(returnedCompanion.retrievedVia).toBe("mandatory_companion");
    expect(Object.hasOwn(returnedCompanion, "recordedAt")).toBe(true);
    expect(returnedCompanion.recordedAt).toEqual(companionRecordedAt);
    expect(Object.hasOwn(returnedOwner, "recordedAt")).toBe(true);
    expect(returnedOwner.recordedAt).toEqual(ownerRecordedAt);
  });

  it("usage.chars は recordedAt/occurredAt を数に入れない（ADR 0035 §2・ADR 0289 の実測を踏襲）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "digest-1",
      recordedAt: new Date("2026-05-01T00:00:00.000Z"),
      occurredAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    await createEmbeddedMemory(stores, [0.99, 0.01], { digest: "digest-22" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const digestChars = result.memories.reduce((sum, m) => sum + m.digest.length, 0);
    expect(result.memories).toHaveLength(2);
    expect(result.usage.byTier.digest).toBe(digestChars);
    expect(result.usage.chars).toBe(digestChars + result.usage.indexChars);
  });
});

describe("recall() — 段3: 矛盾の解決と必須の同伴取得（docs/recall.md §8）", () => {
  async function setupContestedPair(stores: ReturnType<typeof createFakeRuntimeStores>) {
    // a から b を指す一方向だけでよい（段3の実装は候補として見つかった側から対向を辿る）。
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
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "C" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5 });
    const ids = result.memories.map((m) => m.memoryId);
    const indexA = ids.indexOf(a.id);
    const indexB = ids.indexOf(b.id);
    // `indexOf` は見つからないとき -1 を返し、片方だけ消えても `Math.abs(indexA - indexB) === 1` が偶然成立しうるので、両方が結果に含まれること（index >= 0）を先に assert する。
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
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

describe("recall() — 段3: contestedWith（互いに contested な記憶が、同伴取得ではなく両方とも自然に候補に入った場合の印、Issue #691 続き）", () => {
  /** 対向側 b も embedding を持ち、スコアだけで候補に入る fixture。mandatory companion 経路を通さず、`companionOf` が付く前提を崩す。 */
  async function setupNaturallyPairedContestedPair(
    runtimeAndStores: ReturnType<typeof buildRuntime>,
  ) {
    const { runtime, stores } = runtimeAndStores;
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "休みは月曜" });
    const b = await createEmbeddedMemory(stores, [0.99, 0.01], { digest: "休みは火曜" });
    const markResult = await runtime.markContested(ctx, a.id, b.id);
    if (markResult.outcome.kind !== "contested") {
      throw new Error(
        `setupNaturallyPairedContestedPair: markContested が failed: ${markResult.outcome.kind}`,
      );
    }
    return { a, b };
  }

  it("🔴 両方とも ann で自然に候補に入ると、両方に contestedWith が付き、相手の memoryId を指す", async () => {
    const built = buildRuntime();
    const { runtime } = built;
    const { a, b } = await setupNaturallyPairedContestedPair(built);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    const returnedA = result.memories.find((m) => m.memoryId === a.id)!;
    const returnedB = result.memories.find((m) => m.memoryId === b.id)!;

    // 前提の確認: 通っていたら既存の companionOf の歯と区別が付かない。
    expect(returnedA.retrievedVia).not.toBe("mandatory_companion");
    expect(returnedB.retrievedVia).not.toBe("mandatory_companion");
    expect(returnedA.companionOf).toBeUndefined();
    expect(returnedB.companionOf).toBeUndefined();

    expect(returnedA.contestedWith).toBe(b.id);
    expect(returnedB.contestedWith).toBe(a.id);
  });

  it("🔴 同伴取得で来た対にも contestedWith が付く（companionOf を経由しても条件にしない。ADR 0335 決定。Issue #1775 の #832）", async () => {
    const { runtime, stores } = buildRuntime();
    // a だけをベクタ検索で拾えるようにし、b は埋め込みを持たない（段3の同伴取得だけが b への経路）。
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "休みは月曜" });
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "休みは火曜" }));
    const markResult = await runtime.markContested(ctx, a.id, b.id);
    expect(markResult.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const returnedA = result.memories.find((m) => m.memoryId === a.id)!;
    const returnedB = result.memories.find((m) => m.memoryId === b.id)!;

    expect(returnedB.retrievedVia).toBe("mandatory_companion");
    expect(returnedB.companionOf).toBe(a.id);
    expect(returnedB.contestedWith).toBe(a.id);
    expect(returnedA.contestedWith).toBe(b.id);
  });

  it("active な（contested でない）記憶には contestedWith が付かない", async () => {
    const { runtime, stores } = buildRuntime();
    const active = await createEmbeddedMemory(stores, [1, 0], { digest: "ただの記憶" });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const returned = result.memories.find((m) => m.memoryId === active.id)!;
    expect(returned.contestedWith).toBeUndefined();
    expect(Object.hasOwn(returned, "contestedWith")).toBe(false);
  });

  it("🔴 status が active のまま contestedWithId だけが（不整合に）設定されている記憶には contestedWith が付かない（status 検査そのものの歯）", async () => {
    // Runtime の公開口は CAS で status と contestedWithId を一緒に動かすので、この組み合わせ（active なのに contestedWithId が生き残る）を作れない。MemoryStore を直接叩く。`contestedWith` は `member.memory.status === "contested"` を見るので、a には付かない。
    const { runtime, stores } = buildRuntime();
    const b = await createEmbeddedMemory(stores, [0.99, 0.01], { digest: "後から見ると無関係" });
    const a = await createEmbeddedMemory(stores, [1, 0], {
      digest: "active なのに contestedWithId が残っている",
      status: "active",
      contestedWithId: b.id,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const returnedA = result.memories.find((m) => m.memoryId === a.id)!;
    expect(returnedA.contestedWith).toBeUndefined();
    expect(Object.hasOwn(returnedA, "contestedWith")).toBe(false);
  });

  it("🔴→✅ 2026-09-27 更新（Issue #959）: 連想枠経由の contested は、対向が取れなければ単独では返らず Unit ごと落ちる", async () => {
    // 対向（phantomPartner）は forgotten なので段3.5 の必須同伴取得で取れず、contestedAlone は Unit ごと落ちる（単独では返らない）。歯の本体は `recall-association-contested-companion.test.ts` に在る。
    const { runtime, stores } = buildRuntime();
    // 対向は外部キー相当の検査（ADR 0047）のため、forgotten でも実在する id を使う。
    const phantomPartner = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", digest: "存在はするが二度と返らない" }),
    );
    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "アンカー本文",
    });
    const contestedAlone = await createEmbeddedMemory(stores, [0, 1], {
      digest: "対向が居ない矛盾",
      status: "contested",
      contestedWithId: phantomPartner.id,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    expect(result.memories.some((m) => m.memoryId === phantomPartner.id)).toBe(false);
    const returned = result.memories.find((m) => m.memoryId === contestedAlone.id);
    expect(returned).toBeUndefined();
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped" && o.count >= 1)).toBe(
      true,
    );
    void anchor;
  });
});

describe("recall() — 段3: contestedWith の条件(c)「相手が返却集合に居る」の歯（Issue #1786、ADR 0335 決定2）", () => {
  /** 条件(a)(b)が真で(c)だけが偽になる入力: 鎖 a→b→c。`fetchMandatoryCompanions` は owner 側（a）の `contestedWithId` だけを辿り相互参照を検査しないので、b は同伴で返るが c は返却集合に居ず、`contestedWith` は付かない。`Runtime.markContested` はこの鎖を作らないので MemoryStore を直接叩いて組む。 */
  it("🔴 鎖 a→b→c: b は (a)(b) が真でも、相手 c が返却集合に居なければ contestedWith が付かない（条件(c) そのものの歯）", async () => {
    const { runtime, stores } = buildRuntime();
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", contestedWithId: c.id, digest: "B" }),
    );
    const a = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: b.id,
      digest: "A",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returnedA = result.memories.find((m) => m.memoryId === a.id)!;
    const returnedB = result.memories.find((m) => m.memoryId === b.id)!;

    expect(returnedB.retrievedVia).toBe("mandatory_companion");
    expect(returnedB.companionOf).toBe(a.id);
    expect(result.memories.some((m) => m.memoryId === c.id)).toBe(false);

    expect(returnedA.contestedWith).toBe(b.id);
    expect(returnedB.contestedWith).toBeUndefined();
  });

  /** c を a・b より低スコアの別 Unit として入れ、budget で c の Unit だけを落とす: 条件(c) が見るのは切り詰め後の返却集合である。対照として budget が c も収めるなら b に contestedWith=c が付く。 */
  it("🔴 鎖 a→b→c で c が budget で落ちた Unit に居るとき、b に contestedWith は付かない。budget が足りれば付く", async () => {
    const { runtime, stores } = buildRuntime();
    const c = await createEmbeddedMemory(stores, [0.8, 0.6], { digest: "C" });
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", contestedWithId: c.id, digest: "B" }),
    );
    const a = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: b.id,
      digest: "A",
    });

    const unlimited = await runtime.recall(ctx, { vector: [1, 0], association: null });
    expect(unlimited.memories.map((m) => m.memoryId).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(unlimited.memories.find((m) => m.memoryId === b.id)!.contestedWith).toBe(c.id);

    // 本体: 1文字ずつの digest 3件のうち、2文字までしか入らない。[a,b] の Unit が残り、c が落ちる。
    const budgeted = await runtime.recall(ctx, {
      vector: [1, 0],
      association: null,
      budget: { maxMemoryChars: 2 },
    });
    expect(budgeted.memories.map((m) => m.memoryId).sort()).toEqual([a.id, b.id].sort());
    expect(budgeted.omitted.some((o) => o.kind === "budget_dropped")).toBe(true);
    expect(budgeted.memories.find((m) => m.memoryId === a.id)!.contestedWith).toBe(b.id);
    expect(budgeted.memories.find((m) => m.memoryId === b.id)!.contestedWith).toBeUndefined();
  });
});

describe("recall() — 片側だけの contested は単独で出さない（Issue #243 / ADR 0136）", () => {
  it("🔴 contestedWithId が null の contested Memory は recall() に単独で出ない。unit_assembly_dropped に計上される", async () => {
    // `Runtime.markContested` はこの状態を作らない（両側 active の CAS）が、`MemoryStore.updateStatus` を直接呼べば作れる。それを `createMemory` で模して、recall 側の防御（ADR 0136）を確認する。
    const { runtime, stores } = buildRuntime();
    const lone = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: null,
      digest: "lone-contested",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(lone.id);
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it("⚠ 鳴ってはいけない側: 正しく相互参照が張られた contested ペアは両方とも出る", async () => {
    const { runtime, stores } = buildRuntime();
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "B".repeat(20) }),
    );
    const a = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: b.id,
      digest: "A".repeat(5),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });
});

describe("recall() — 段4: トークン予算による切り詰め（Issue #108。maxMemoryChars 以外の経路に歯が無かった）", () => {
  /** 3件の日本語 digest をベクトルの向きで優先順位を制御する（`units.sort` の rankScore が決める）。digest は "あ" x10 = 9 トークン、3件 27 トークンは `maxMemoryTokens: 20` に収まらず、スコアの高い2件が残る。 */
  it("maxMemoryTokens は既定カウンタで数えた digest 合計を上限内に切り詰める", async () => {
    const { runtime, stores } = buildRuntime();
    const digest = "あ".repeat(10);
    expect(heuristicTokenCounter.count(digest).tokens).toBe(9);

    const top = await createEmbeddedMemory(stores, [1, 0], { digest });
    const middle = await createEmbeddedMemory(stores, [0.99, 0.14], { digest });
    const bottom = await createEmbeddedMemory(stores, [0.9, 0.44], { digest });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryTokens: 20 },
    });

    const returnedIds = result.memories.map((m) => m.memoryId);
    expect(returnedIds).toEqual([top.id, middle.id]);
    expect(returnedIds).not.toContain(bottom.id);

    const returnedTokenSum = result.memories.reduce(
      (sum, m) => sum + heuristicTokenCounter.count(m.digest).tokens,
      0,
    );
    expect(returnedTokenSum).toBeLessThanOrEqual(20);
    expect(returnedTokenSum).toBe(18);

    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });

  /** `effectiveTokenBudget` は小さいほうを採る。`maxMemoryTokens` は2件残る大きさ（100）にし、`promptBudgetTokens: 10` を同時に渡す。緩いほうを採っていたら2件残ってしまうので区別できる。 */
  it("promptBudgetTokens は maxMemoryTokens より小さいほうが優先される", async () => {
    const { runtime, stores } = buildRuntime();
    const digest = "あ".repeat(10); // 9トークン/件
    const top = await createEmbeddedMemory(stores, [1, 0], { digest });
    const second = await createEmbeddedMemory(stores, [0.99, 0.14], { digest });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryTokens: 100, promptBudgetTokens: 10 },
    });

    const returnedIds = result.memories.map((m) => m.memoryId);
    expect(returnedIds).toEqual([top.id]);
    expect(returnedIds).not.toContain(second.id);
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });
});

describe("recall() — budget_truncation の detail.droppedFitsWhenConcatenated（Issue #829 / ADR 0097 追記）", () => {
  /** 21文字（非CJK）の digest を4件、`maxMemoryTokens: 23` で渡す。段4の強制側は digest ごとに ceil（6×4=24 > 23）で1件落とすが、連結して1回数えると 22 トークンで収まる。ふるまいは変えず（ADR 0097）、予算に余りがあるのに落としたことが `detail.droppedFitsWhenConcatenated` から読めることだけを検査する。 */
  const DIGEST_21_NON_CJK = "a".repeat(21);

  it("直す前は無かった欄: 4件とも収まるのに1件落ちるとき、detail.droppedFitsWhenConcatenated が true になる", async () => {
    expect(heuristicTokenCounter.count(DIGEST_21_NON_CJK).tokens).toBe(6);
    const joined = Array(4).fill(DIGEST_21_NON_CJK).join("\n");
    expect(joined.length).toBe(87);
    expect(heuristicTokenCounter.count(joined).tokens).toBe(22);

    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 4; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], { digest: DIGEST_21_NON_CJK });
    }

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryTokens: 23 },
    });

    expect(result.memories).toHaveLength(3);
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });

    const budgetTruncation = result.explain.stages.find((s) => s.stage === "budget_truncation");
    expect(budgetTruncation?.detail?.droppedFitsWhenConcatenated).toBe(true);
  });

  it("⚠ 鳴ってはいけない側: 連結しても本当に収まらないときは droppedFitsWhenConcatenated が false", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 4; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], { digest: DIGEST_21_NON_CJK });
    }

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryTokens: 20 },
    });

    expect(result.memories).toHaveLength(3);
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });

    const budgetTruncation = result.explain.stages.find((s) => s.stage === "budget_truncation");
    expect(budgetTruncation?.detail?.droppedFitsWhenConcatenated).toBe(false);
  });

  it("⚠ 鳴ってはいけない側その2: budget_dropped が無いときは欄自体が出ない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: DIGEST_21_NON_CJK });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryTokens: 100 },
    });

    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);
    const budgetTruncation = result.explain.stages.find((s) => s.stage === "budget_truncation");
    expect(budgetTruncation?.detail?.droppedFitsWhenConcatenated).toBeUndefined();
    expect("droppedFitsWhenConcatenated" in (budgetTruncation?.detail ?? {})).toBe(false);
  });

  /** 同じ4件（21文字×4）に予算を変えて当てる。どれも1件落ちる。 */
  async function recallWith(budget: { maxMemoryTokens?: number; maxMemoryChars?: number }) {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 4; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], { digest: DIGEST_21_NON_CJK });
    }
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, budget });
    expect(result.memories).toHaveLength(3);
    const stage = result.explain.stages.find((s) => s.stage === "budget_truncation");
    return stage?.detail?.droppedFitsWhenConcatenated;
  }

  it("連結は改行区切りで数える: 区切りなしなら21トークンに収まるが、改行込みの22トークンは21に収まらない", async () => {
    expect(await recallWith({ maxMemoryTokens: 21 })).toBe(false);
  });

  it("連結のトークン数が予算ちょうど（22）なら収まったとみなす", async () => {
    expect(await recallWith({ maxMemoryTokens: 22 })).toBe(true);
  });

  it("トークンが足りていても、連結の文字数（87）が maxMemoryChars を超えれば収まらない", async () => {
    // digest ごとの文字数の合計は 84 で 85 に収まる（文字数では落ちない）。トークン（23）で1件落ちる。
    expect(await recallWith({ maxMemoryTokens: 23, maxMemoryChars: 85 })).toBe(false);
  });

  it("連結の文字数がちょうど maxMemoryChars（87）なら収まったとみなす", async () => {
    expect(await recallWith({ maxMemoryTokens: 23, maxMemoryChars: 87 })).toBe(true);
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

describe("recall() — digestBand（目次帯。docs/recall.md §5、本 PR）", () => {
  it("『返さなかったもの』だけが帯に載る。memories に返ったものは帯に含まれない", async () => {
    const { runtime, stores } = buildRuntime();
    const returned = await createEmbeddedMemory(stores, [1, 0]);
    const notReturned1 = await stores.memoryStore.createMemory(ctx, newMemory());
    const notReturned2 = await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.memories.map((m) => m.memoryId)).toEqual([returned.id]);
    const bandIds = (result.index.digestBand ?? []).map((e) => e.memoryId);
    expect(bandIds).not.toContain(returned.id);
    expect(bandIds.sort()).toEqual([notReturned1.id, notReturned2.id].sort());
  });

  it("digestBandCoverage.shown は digestBand.length と一致する", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.recall(ctx, {});
    expect(result.index.digestBandCoverage).toBeDefined();
    expect(result.index.digestBandCoverage?.shown).toBe((result.index.digestBand ?? []).length);
  });

  it("スコープ内が全部 memories に返っているとき（eligible=0）、帯は空で limitedBy は付かない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.index.digestBand).toEqual([]);
    expect(result.index.digestBandCoverage).toEqual({
      shown: 0,
      eligible: 0,
      countKind: "exact",
    });
  });

  it("digestBandLimit を小さく渡すと limitedBy === 'entry_limit' になる", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory());
    }

    const result = await runtime.recall(ctx, { digestBandLimit: 2 });
    expect(result.index.digestBand).toHaveLength(2);
    expect(result.index.digestBandCoverage?.eligible).toBe(5);
    expect(result.index.digestBandCoverage?.limitedBy).toBe("entry_limit");
  });

  /** `digestBandLimit` に巨大な値を渡すのは、上限を緩めても資格件数を超えないことを store から段5までの経路で見るため（`packDigestBand` の同名の歯は純関数の層）。 */
  it("digestBandLimit に巨大な値を渡しても shown は eligible を超えない", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory());
    }

    const result = await runtime.recall(ctx, { digestBandLimit: 10_000 });
    const coverage = result.index.digestBandCoverage;
    expect(coverage).toBeDefined();
    expect(coverage!.eligible).toBe(5);
    expect(coverage!.shown).toBeLessThanOrEqual(coverage!.eligible);
    expect(coverage!.shown).toBe(5);
    expect(coverage!.limitedBy).toBeUndefined();
  });

  /** 上の歯は切り詰めが起きないので `eligible === shown` で、`eligible` を `shown` で上書きする壊れ方を通す。切り詰めが起きている状態で `eligible` が `shown` より大きいことを独立に主張する（推定値を実測値の顔で出さない、ADR 0008）。 */
  it("上限で切られたとき、eligible は shown より大きい（切ったことを隠さない）", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory());
    }

    const result = await runtime.recall(ctx, { digestBandLimit: 2 });
    const coverage = result.index.digestBandCoverage;
    expect(coverage).toBeDefined();
    expect(coverage!.limitedBy).toBeDefined();
    expect(coverage!.eligible).toBeGreaterThan(coverage!.shown);
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
    expect(result.usage.share).toBeCloseTo(
      (result.usage.chars - result.usage.indexChars) / 1000,
      10,
    );
    expect(result.usage.indexChars).toBeGreaterThan(0);
  });

  /** 目次帯は budget の対象外（ADR 0008: 0件でも何が在るかは言える）なので、目次帯より小さい budget でも削られない。share の分子に目次帯を含めると 1 を超える（「予算の何割を使ったか」と「全体でいくらかかったか」は別の問い）。 */
  it("目次帯より小さい budget でも、目次帯は削られず、share は 1 を超えない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0], budget: { maxMemoryChars: 1 } });

    expect(result.usage.indexChars).toBeGreaterThan(1);
    expect(result.usage.chars).toBeGreaterThan(1);
    expect(result.usage.share).toBeLessThanOrEqual(1);
  });
});

/** `share` からは導出しない: 強制側（段4）は digest ごとに ceil するが、`share` の分子は連結した1本に対して ceil を1回だけ行い、両者は加法的に一致しない。 */
describe("recall() — usage.budgetExceeded（Issue #108「案3」）", () => {
  it("budget を渡さない場合は budgetExceeded が無い（欄そのものが存在しない）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.usage.budgetExceeded).toBeUndefined();
    expect(result.usage.share).toBeUndefined();
  });

  it("budget: {}（予算次元が1つも無い）でも budgetExceeded は無い（share と存在条件が一致する）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0], budget: {} });
    expect(result.usage.budgetExceeded).toBeUndefined();
    expect(result.usage.share).toBeUndefined();
  });

  it("予算内に収まっていれば budgetExceeded は false（undefined ではなく明示的に false）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "short" });
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 10_000, maxMemoryTokens: 10_000, promptBudgetTokens: 10_000 },
    });
    expect(result.usage.budgetExceeded).toBe(false);
  });

  /** 非CJK 20字の digest 2件（各5トークン）に `maxMemoryTokens: 10`: 段4は digest ごとに ceil して 5+5=10 で両方残すが、連結（41字）で測り直すと 11 > 10。`share` が 1 を超えることと `budgetExceeded` を同じケースで両方測る（`budgetExceeded` だけだと分子の数え方が変わっても気づけない）。 */
  it("非CJK20字×2件・maxMemoryTokens:10 ⟹ 強制側は両方残すが、連結して測り直すと超えている（share>1 かつ budgetExceeded=true）", async () => {
    const digestA = "01234567890123456789"; // 20 chars, 全て非CJK
    const digestB = "abcdefghijklmnopqrst"; // 20 chars, 全て非CJK
    expect(digestA).toHaveLength(20);
    expect(digestB).toHaveLength(20);

    expect(heuristicTokenCounter.count(digestA).tokens).toBe(5);
    expect(heuristicTokenCounter.count(digestB).tokens).toBe(5);
    expect(
      heuristicTokenCounter.count(digestA).tokens + heuristicTokenCounter.count(digestB).tokens,
    ).toBe(10);
    expect(heuristicTokenCounter.count(`${digestA}\n${digestB}`).tokens).toBe(11);

    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 10 },
    });

    // 強制側は両方残す: budget_dropped が起きた入力からの true では意味が無い。
    expect(result.memories).toHaveLength(2);
    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);

    expect(result.usage.share).toBeCloseTo(1.1, 10);
    expect(result.usage.share).toBeGreaterThan(1);
    expect(result.usage.budgetExceeded).toBe(true);
  });

  /** 上と同じ入力で、出力検証（既定 report）を通しても `share` が 1.1・`budgetExceeded` が true のまま・`ok === true` であること。`share > 1` は合法な値なので、`.max(1)` を戻す変異が緑のまま入り込むのを防ぐ。 */
  it("T3: ADR 0097 の share>1（非CJK20字の digest 2件・maxMemoryTokens:10）は出力検証でも弾かれない", async () => {
    const digestA = "01234567890123456789";
    const digestB = "abcdefghijklmnopqrst";

    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 10 },
    });

    expect(result.usage.share).toBeCloseTo(1.1, 10);
    expect(result.usage.budgetExceeded).toBe(true);
    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
  });

  /** 対照: `maxMemoryTokens` だけを 11（連結した量ちょうど）に変える。10→11 の1つの動きで true → false に反転する。これが無いと、歯1 は `budgetExceeded` を常に true と主張するだけでも緑になる。 */
  it("同じ2件の digest でも maxMemoryTokens:11（＝連結した量ちょうど）なら share は1、budgetExceeded は false（対照）", async () => {
    const digestA = "01234567890123456789";
    const digestB = "abcdefghijklmnopqrst";

    expect(heuristicTokenCounter.count(`${digestA}\n${digestB}`).tokens).toBe(11);

    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 11 },
    });

    expect(result.memories).toHaveLength(2);
    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);

    expect(result.usage.share).toBe(1);
    expect(result.usage.budgetExceeded).toBe(false);
  });

  /** 境界の実測: `maxMemoryTokens` を 10 / 11 / 12 と動かし、`share` が 1 をまたぐ境界を固定する。期待値は `heuristicTokenCounter` を直接呼んで独立に導いた値で、実装を読み写していない。 */
  it.each([
    { maxMemoryTokens: 10, expectedShare: 1.1, expectedExceeded: true },
    { maxMemoryTokens: 11, expectedShare: 1, expectedExceeded: false },
    { maxMemoryTokens: 12, expectedShare: 11 / 12, expectedExceeded: false },
  ])(
    "境界の実測: maxMemoryTokens=$maxMemoryTokens ⟹ share≈$expectedShare, budgetExceeded=$expectedExceeded",
    async ({ maxMemoryTokens, expectedShare, expectedExceeded }) => {
      const digestA = "01234567890123456789";
      const digestB = "abcdefghijklmnopqrst";

      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
      await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        budget: { maxMemoryTokens },
      });

      // 境界を作っているのは分子（連結して測った11）の側で、強制側の落ちではない。
      expect(result.memories).toHaveLength(2);

      expect(result.usage.share).toBeCloseTo(expectedShare, 10);
      expect(result.usage.budgetExceeded).toBe(expectedExceeded);
    },
  );

  // `promptBudgetTokens` 単独でも同じ再現が起きる: 他の歯は `promptBudgetTokens` を使わず、`promptTokensExceeded` の項を判定から落とす変異を検出できない。
  it("promptBudgetTokens 単独でも、maxMemoryTokens と同じ再現で budgetExceeded が true になる", async () => {
    const digestA = "01234567890123456789";
    const digestB = "abcdefghijklmnopqrst";
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { promptBudgetTokens: 10 },
    });

    expect(result.memories).toHaveLength(2);
    expect(result.usage.budgetExceeded).toBe(true);
  });

  // 境界値（ちょうど予算どおり）では false のまま: `>` を `>=` に変える変異は、測定値が予算を上回る歯では同じ true になり見抜けない。単一の memory を使う（結合の "\n" が挟まらず境界を厳密に作れる）。
  it("トークン予算にちょうど収まる境界値では budgetExceeded は false のまま（`>` と `>=` を区別する歯）", async () => {
    const digest = "01234567890123456789"; // 20 chars, non-CJK ⟹ ceil(20/4) = 5 トークン
    expect(heuristicTokenCounter.count(digest).tokens).toBe(5);

    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 5 },
    });

    expect(result.memories).toHaveLength(1);
    expect(result.usage.budgetExceeded).toBe(false);
  });

  it("chars 予算とトークン予算を両方申告しても、chars 次元が判定から落ちない（トークン超過は検知され続ける）", async () => {
    const digestA = "01234567890123456789";
    const digestB = "abcdefghijklmnopqrst";
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 10_000, maxMemoryTokens: 10 },
    });

    expect(result.usage.budgetExceeded).toBe(true);
    expect(result.usage.share).toBeDefined();
  });

  /** `maxMemoryChars` は強制側と計測側が同じ式（digest.length の合計）で、連結の区切りも複数回の ceil も無いため、構造上この経路では常に false のまま（tokens と違って true になる入力は作れない）。 */
  it("maxMemoryChars のみの経路では budgetExceeded は false のままである", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "0123456789" }); // 10 chars
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 5 },
    });
    expect(result.usage.budgetExceeded).toBe(false);
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
    // 例外の型を ZodError に固定する: 別の理由（モジュール解決エラーなど）で失敗しても緑になってはいけないため。
    await expect(runtime.recall(ctx, { limit: 0 })).rejects.toThrow(ZodError);
  });

  it("excludeProvenanceKinds に未知の値を渡すと拒否する", async () => {
    const { runtime } = buildRuntime();
    await expect(
      // @ts-expect-error 意図的に不正な値を渡す
      runtime.recall(ctx, { excludeProvenanceKinds: ["fabricated"] }),
    ).rejects.toThrow(ZodError);
  });
});

/** 壊れた出力は、モンキーパッチではなく呼び出し側が実際に差せる `RuntimeDeps.tokenCounter` に非整数を返す実装を渡して作る（`usage.estimatedTokens` は `int()`）。`share > 1` は契約違反ではない（ADR 0097 が `.max(1)` を外した。上の T3 が測る）。 */
describe("recall() — 出力検証（Issue #131、ADR 0098）", () => {
  /** 非整数のトークン数を返す `TokenCounter`。`usage.estimatedTokens` の `int()` を破る。 */
  const fractionalTokenCounter: TokenCounter = {
    count: () => ({ tokens: 2.5, counter: "heuristic" }),
  };

  it("T1: 契約を破った出力（usage.estimatedTokens が非整数）を検出する", async () => {
    const { runtime, stores } = buildRuntime({ tokenCounter: fractionalTokenCounter });
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.usage.estimatedTokens).toBe(2.5);
    expect(result.outputValidation?.ok).toBe(false);
    expect(result.outputValidation?.issues.map((issue) => issue.path)).toContain(
      "usage.estimatedTokens",
    );
  });

  /** T2（対照）: これが無いと「何でも弾く」実装が T1 だけで緑になる。 */
  it("T2: 正しい出力は素通りする（ok: true・issues は空）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
  });

  /** 「検証していない」と「検証して通った」を潰さない: "off" では欄そのものが無く、`{ ok: true }` にはならない。 */
  it('T4: "off" では欄そのものが無い（未検証と通過を潰さない）。値は素通りする', async () => {
    const { runtime, stores } = buildRuntime({
      tokenCounter: fractionalTokenCounter,
      outputValidation: "off",
    });
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.outputValidation).toBeUndefined();
    expect(result.usage.estimatedTokens).toBe(2.5);
  });

  it('T5: "throw" では RecallOutputValidationError を投げ、issues と recallId を載せる', async () => {
    const { runtime, stores } = buildRuntime({
      tokenCounter: fractionalTokenCounter,
      outputValidation: "throw",
    });
    await createEmbeddedMemory(stores, [1, 0]);

    const err = await runtime.recall(ctx, { vector: [1, 0] }).then(
      () => {
        throw new Error("recall() が resolve した——投げるはずだった");
      },
      (caught: unknown) => caught,
    );

    expect(err).toBeInstanceOf(RecallOutputValidationError);
    const validationError = err as RecallOutputValidationError;
    expect(validationError.issues.length).toBeGreaterThan(0);
    // 段6（記録）は検証より前に走っている——呼び出し側が相関を取れるように id を載せる。
    expect(validationError.recallId).toBeTruthy();
  });

  /** 既定は "throw" ではない: recall() は主経路で、投げる形にすると誤った値のまま動いていた呼び出しが例外になる破壊的変更になる。 */
  it("T6: モードを渡さないとき、検証に落ちても recall() は投げない（既定は report）", async () => {
    const { runtime, stores } = buildRuntime({ tokenCounter: fractionalTokenCounter });
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.outputValidation?.ok).toBe(false);
    expect(result.memories).toHaveLength(1);
  });
});

// 今日の `eligible = aggregate.totalInScope - notIndexedTotal` は `excludeProvenanceKinds` で除外した kind の行も数える。`aggregateScope` が任意の欄 `excludedProvenanceIndexedCount` を返し、core がそれで eligible と下限を引き直す。欄を返さない adapter では挙動を変えない（下の「対照」が固定する）。
describe("recall() — ann_unreached × excludeProvenanceKinds（ADR 0390）", () => {
  /** 索引は近傍 `reach` 件しか見ず、除外は後置フィルタで落とす VectorStore: 除外行が候補枠を占拠して、除外しない候補を取りこぼす近似索引の形。 */
  class ReachLimitedPostFilterVectorStore implements VectorStore {
    constructor(
      private readonly inner: VectorStore,
      private readonly reach: number,
      private readonly excludedIds: ReadonlySet<string>,
    ) {}

    upsert(...args: Parameters<VectorStore["upsert"]>): ReturnType<VectorStore["upsert"]> {
      return this.inner.upsert(...args);
    }

    async search(...args: Parameters<VectorStore["search"]>): ReturnType<VectorStore["search"]> {
      const [c, space, query, opts] = args;
      const { excludeProvenanceKinds: _dropped, ...filter } = opts.filter;
      const hits = await this.inner.search(c, space, query, { ...opts, filter });
      return hits.slice(0, this.reach).filter((h) => !this.excludedIds.has(h.memoryId));
    }

    delete(...args: Parameters<VectorStore["delete"]>): ReturnType<VectorStore["delete"]> {
      return this.inner.delete(...args);
    }

    deleteAcrossSpaces(
      ...args: Parameters<VectorStore["deleteAcrossSpaces"]>
    ): ReturnType<VectorStore["deleteAcrossSpaces"]> {
      return this.inner.deleteAcrossSpaces(...args);
    }
  }

  function withoutExcludedProvenanceField(
    memoryStore: ReturnType<typeof createFakeRuntimeStores>["memoryStore"],
  ) {
    return new Proxy(memoryStore, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === "aggregateScope" && typeof value === "function") {
          return async (...args: unknown[]) => {
            const aggregate = (await (value as (...a: unknown[]) => Promise<object>).apply(
              target,
              args,
            )) as Record<string, unknown>;
            const { excludedProvenanceIndexedCount: _dropped, ...rest } = aggregate;
            return rest;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function buildRuntimeWith(
    stores: ReturnType<typeof createFakeRuntimeStores>,
    opts: {
      vectorStore?: VectorStore;
      stripField?: boolean;
      wrapMemoryStore?: (store: typeof stores.memoryStore) => typeof stores.memoryStore;
    } = {},
  ) {
    const baseStore = opts.stripField
      ? (withoutExcludedProvenanceField(stores.memoryStore) as typeof stores.memoryStore)
      : stores.memoryStore;
    return createRuntime({
      memoryStore: opts.wrapMemoryStore ? opts.wrapMemoryStore(baseStore) : baseStore,
      outboxStore: stores.outboxStore,
      vectorStore: opts.vectorStore ?? stores.vectorStore,
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
  }

  const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };

  function annDetail(result: RecallResult) {
    return result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.channel === "ann",
    )?.detail;
  }

  /** 問い1の形: 除外 kind 4件がクエリに最も近く、除外しない3件は少し遠い。索引の reach=4。 */
  async function seedQ1(stripField: boolean) {
    const stores = createFakeRuntimeStores();
    const excluded = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const m = await createEmbeddedMemory(stores, [1, 0], { provenance: consolidated });
      excluded.add(m.id);
    }
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 1]);
    }
    const runtime = buildRuntimeWith(stores, {
      vectorStore: new ReachLimitedPostFilterVectorStore(stores.vectorStore, 4, excluded),
      stripField,
    });
    return runtime;
  }

  /** 問い2の形: 除外しない3件も除外4件も全部 [1,0]。素の fake VectorStore（除外は索引が効かせる）。 */
  async function seedQ2(stripField: boolean) {
    const stores = createFakeRuntimeStores();
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }
    for (let i = 0; i < 4; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], { provenance: consolidated });
    }
    return buildRuntimeWith(stores, { stripField });
  }

  it("問い1（黙る）: 除外指定で ANN が除外しない候補を取りこぼしたら、warning と診断キー（除外後の下限）が付く", async () => {
    const runtime = await seedQ1(false);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["consolidated"],
    });

    expect(result.memories).toEqual([]);
    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "warning",
    });
    expect(annDetail(result)).toMatchObject({
      annReturnedFewerThanReachable: true,
      annReachableLowerBound: 3,
    });
  });

  it("問い2（鳴りすぎ）: 除外指定で除外しない候補を全部拾えたら、ann_unreached は鳴らない", async () => {
    const runtime = await seedQ2(false);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["consolidated"],
    });

    expect(result.memories).toHaveLength(3);
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
    expect(Object.keys(annDetail(result) ?? {})).not.toContain("annReturnedFewerThanReachable");
  });

  it("対照1（欄を返さない adapter は今日と同じ）: 問い1の形でも severity は info・診断キー無し", async () => {
    const runtime = await seedQ1(true);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["consolidated"],
    });

    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "info",
    });
    const keys = Object.keys(annDetail(result) ?? {});
    expect(keys).not.toContain("annReturnedFewerThanReachable");
    expect(keys).not.toContain("annReachableLowerBound");
  });

  it("対照2（欄を返さない adapter は今日と同じ）: 問い2の形では今日どおり info で ann_unreached が鳴る", async () => {
    const runtime = await seedQ2(true);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["consolidated"],
    });

    expect(result.memories).toHaveLength(3);
    expect(result.omitted).toContainEqual({
      kind: "ann_unreached",
      countKind: "unknown",
      severity: "info",
    });
  });

  it("対照3（除外指定なしは変わらない）: excludeProvenanceKinds 省略・空配列では、欄の有無に関わらず結果が一致する", async () => {
    for (const excludeProvenanceKinds of [undefined, [] as never[]]) {
      const outcomes: unknown[] = [];
      for (const stripField of [false, true]) {
        const runtime = await seedQ2(stripField);
        const result = await runtime.recall(ctx, {
          vector: [1, 0],
          ...(excludeProvenanceKinds === undefined ? {} : { excludeProvenanceKinds }),
        });
        outcomes.push({
          omitted: result.omitted,
          detail: annDetail(result),
          memories: result.memories.length,
        });
      }
      expect(outcomes[0]).toEqual(outcomes[1]);
    }
  });

  // "skip" では件数を数えず eligible が 0 になるので、ANN の取りこぼしを `ann_unreached` が名乗れない。core の Fake は `scopeAggregate` を実装しない（常に exact）ので、"skip" の返り値の形（countKind 'unknown'、件数 0）をここで模す。
  function skippingAggregateScope(
    memoryStore: ReturnType<typeof createFakeRuntimeStores>["memoryStore"],
    honorSkip: boolean,
  ) {
    return new Proxy(memoryStore, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === "aggregateScope" && typeof value === "function") {
          return async (...args: unknown[]) => {
            const aggregate = (await (value as (...a: unknown[]) => Promise<object>).apply(
              target,
              args,
            )) as Record<string, unknown>;
            const opts = args[2] as { scopeAggregate?: string } | undefined;
            if (!honorSkip || opts?.scopeAggregate !== "skip") return aggregate;
            const zero = { count: 0, countKind: "unknown" };
            return {
              ...aggregate,
              groups: [],
              totalInScope: 0,
              countKind: "unknown",
              notIndexed: { pending: zero, failed: zero, skipped: zero },
              filteredArchived: zero,
              filteredSuperseded: zero,
              filteredForgotten: zero,
              filteredPeriod: zero,
              filteredExpired: zero,
              filteredNotYetValid: zero,
              filteredTaxonomy: zero,
              filteredDecayed: zero,
              digestEligible: zero,
            };
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async function seedSkipRuntime(honorSkip: boolean) {
    const stores = createFakeRuntimeStores();
    // ANN の届く範囲が狭い（reach=2）索引。scope には5件あるので、exact なら取りこぼしを名乗れる形。
    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }
    return buildRuntimeWith(stores, {
      vectorStore: new ReachLimitedPostFilterVectorStore(stores.vectorStore, 2, new Set()),
      wrapMemoryStore: (store) => skippingAggregateScope(store, honorSkip),
    });
  }

  it("skip 1（判定できないと名乗る）: scopeAggregate: 'skip' で ANN の段が走ったとき、stage detail に annReachability: 'unknown' が付く", async () => {
    const runtime = await seedSkipRuntime(true);

    const result = await runtime.recall(ctx, { vector: [1, 0], scopeAggregate: "skip" });

    expect(result.index.countKind).toBe("unknown");
    expect(annDetail(result)).toMatchObject({ channel: "ann", annReachability: "unknown" });
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
    expect(Object.keys(annDetail(result) ?? {})).not.toContain("annReturnedFewerThanReachable");
  });

  it("skip 2（既定は変わらない）: scopeAggregate を渡さない・'exact' を渡すときは annReachability を足さない", async () => {
    for (const query of [{}, { scopeAggregate: "exact" as const }]) {
      const runtime = await seedSkipRuntime(true);
      const result = await runtime.recall(ctx, { vector: [1, 0], ...query });
      expect(Object.keys(annDetail(result) ?? {})).not.toContain("annReachability");
      expect(annDetail(result)).toMatchObject({ annReturnedFewerThanReachable: true });
    }
  });

  it("skip 3（skip を無視する adapter）: 'skip' を頼んでも exact が返ってきたら annReachability は付かず、従来の判定になる", async () => {
    const runtime = await seedSkipRuntime(false);

    const result = await runtime.recall(ctx, { vector: [1, 0], scopeAggregate: "skip" });

    expect(result.index.countKind).toBe("exact");
    expect(Object.keys(annDetail(result) ?? {})).not.toContain("annReachability");
    expect(annDetail(result)).toMatchObject({ annReturnedFewerThanReachable: true });
  });

  it("skip 4（ANN の段が走らないとき）: クエリに埋め込む内容が無ければ、skip でも annReachability は付かない", async () => {
    const runtime = await seedSkipRuntime(true);

    const result = await runtime.recall(ctx, { scopeAggregate: "skip" });

    const keys = result.explain.stages.flatMap((s) => Object.keys(s.detail ?? {}));
    expect(keys).not.toContain("annReachability");
  });
});

describe("recall() — TokenCounter が約束を破る値を返したとき（ADR 0497）", () => {
  const digests = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
  async function run(
    tokenCounter: TokenCounter | undefined,
    budget: { maxMemoryTokens: number } | undefined,
    outputValidation?: RecallOutputValidationMode,
  ) {
    const { runtime, stores } = buildRuntime({
      ...(tokenCounter ? { tokenCounter } : {}),
      ...(outputValidation ? { outputValidation } : {}),
    });
    for (const digest of digests) {
      await createEmbeddedMemory(stores, [1, 0], { digest, contentHash: digest });
    }
    return runtime.recall(ctx, { vector: [1, 0], ...(budget ? { budget } : {}) });
  }
  const budget = { maxMemoryTokens: 4 };

  it("陽性対照: 1件3トークンの exact な counter は、4トークンの予算で1件だけ残し、検証も通る", async () => {
    const result = await run({ count: () => ({ tokens: 3, counter: "exact" }) }, budget);
    expect(result.memories).toHaveLength(1);
    expect(result.usage.counter).toBe("exact");
    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ["NaN", NaN, /NaN/],
    ["負の数", -5, /negative/],
    ["負の無限大", -Infinity, /-Infinity/],
    ["Infinity", Infinity, /Infinity/],
  ])(
    "%s を返す counter は、予算の有無・outputValidation の値にかかわらず RangeError で断る",
    async (_n, tokens, pattern) => {
      const counter: TokenCounter = { count: () => ({ tokens, counter: "exact" }) };
      await expect(run(counter, budget)).rejects.toThrow(RangeError);
      await expect(run(counter, budget)).rejects.toThrow(pattern);
      await expect(run(counter, undefined)).rejects.toThrow(RangeError);
      await expect(run(counter, budget, "off")).rejects.toThrow(RangeError);
    },
  );

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["数でない tokens（文字列）", { tokens: "3", counter: "exact" }],
    ["tokens の欄が無い", { counter: "exact" }],
    ["tokens が null", { tokens: null, counter: "exact" }],
  ])("戻り値が壊れている（%s）counter も RangeError で断る", async (_n, value) => {
    const counter = { count: () => value } as unknown as TokenCounter;
    await expect(run(counter, budget)).rejects.toThrow(RangeError);
    await expect(run(counter, undefined)).rejects.toThrow(RangeError);
  });

  it("message には値の種類が入り、入力テキスト（digest）は入らない", async () => {
    const counter: TokenCounter = { count: () => ({ tokens: NaN, counter: "exact" }) };
    const error = await run(counter, budget).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
    const message = (error as RangeError).message;
    expect(message).toMatch(/tokenCounter/);
    for (const digest of digests) expect(message).not.toContain(digest);
  });

  it("最初の壊れた値で止まる: 壊れた値を返した呼び出しの後で、counter はもう呼ばれない", async () => {
    let calls = 0;
    const counter: TokenCounter = {
      count: () => {
        calls += 1;
        return { tokens: calls === 2 ? NaN : 1, counter: "exact" };
      },
    };
    await expect(run(counter, { maxMemoryTokens: 100 })).rejects.toThrow(RangeError);
    expect(calls).toBe(2);
  });

  it("段4の2件目以降の digest で壊れた値が出ても断る（1件目だけを検査して終わらない）", async () => {
    let calls = 0;
    const counter: TokenCounter = {
      count: () => {
        calls += 1;
        return { tokens: calls >= 3 ? -1 : 1, counter: "exact" };
      },
    };
    await expect(run(counter, { maxMemoryTokens: 100 })).rejects.toThrow(RangeError);
  });

  it("usage の計測（連結した文字列）でだけ壊れた値を返す counter も、予算が無くても断る", async () => {
    // digest 1件（10文字）は正常、連結（>10文字）で NaN。予算なしなので usage の計測でしか呼ばれない。
    const counter: TokenCounter = {
      count: (text) => ({ tokens: text.length > 10 ? NaN : 1, counter: "exact" }),
    };
    await expect(run(counter, undefined)).rejects.toThrow(RangeError);
  });

  it("段4で落ちたときの連結の測り直し（Issue #829）の壊れた値も断る", async () => {
    // 段4は digest ごと（10文字）で数えて落とす。連結の測り直しでは長い文字列に NaN を返す。
    const counter: TokenCounter = {
      count: (text) => ({ tokens: text.length > 10 ? NaN : 3, counter: "exact" }),
    };
    await expect(run(counter, budget)).rejects.toThrow(RangeError);
  });

  it("例外を投げる counter の例外は、包まずそのまま recall() の失敗になる（予算が無くても usage の計測で呼ばれる）", async () => {
    const boom = new Error("boom");
    const counter: TokenCounter = {
      count: () => {
        throw boom;
      },
    };
    await expect(run(counter, budget)).rejects.toBe(boom);
    await expect(run(counter, undefined)).rejects.toBe(boom);
  });

  it.each([
    ["0", 0],
    ["小数 0.5", 0.5],
    ["大きな有限値", 1e12],
  ])(
    "やりすぎない: %s を返す counter は通る（有限で 0 以上なら整数でなくてよい）",
    async (_n, tokens) => {
      const result = await run({ count: () => ({ tokens, counter: "exact" }) }, undefined);
      expect(result.memories).toHaveLength(3);
      expect(result.usage.estimatedTokens).toBe(tokens);
    },
  );

  it("既定の heuristicTokenCounter は断られない（空・CJK・絵文字・孤立サロゲート・長い digest でも、予算ありで通る）", async () => {
    const { runtime, stores } = buildRuntime();
    const odd = ["日本語のダイジェスト", "emoji \u{1F600} \uD800 é", "x".repeat(5000)];
    for (const [i, digest] of odd.entries()) {
      await createEmbeddedMemory(stores, [1, 0], { digest, contentHash: `h${i}` });
    }
    // 空の digest は、ADR 0630 から書き込みの口が拒む（書けない）。ただし、それより前に書かれた行には残りうるので、
    // 読み側が断られないことは、書いた後の行を書き換えて縛る（Fake の内部の `backing` を直接書き換える）。
    const emptyDigest = await createEmbeddedMemory(stores, [1, 0], { contentHash: "h-empty" });
    (
      stores.memoryStore as unknown as { backing: { memories: Map<string, Memory> } }
    ).backing.memories.get(emptyDigest.id)!.digest = "";
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 100000 },
    });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.usage.estimatedTokens)).toBe(true);
    expect(result.usage.counter).toBe("heuristic");
    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ["counter の欄が無い", undefined],
    ["counter が範囲外の文字列", "bogus"],
  ])(
    "%s: tokens が正常なら通り、値はそのまま usage.counter に出て、検証で知らされる（ADR 0483 のまま。ADR 0497 の対象外）",
    async (_n, counter) => {
      const result = await run({ count: () => ({ tokens: 3, counter }) as never }, undefined);
      expect(result.usage.counter).toBe(counter);
      expect(result.outputValidation?.issues.map((i) => i.path)).toContain("usage.counter");
    },
  );
});

describe("recall() — usage.counter の印は連結の計測の印（ADR 0487、今の振る舞い）", () => {
  it("長さで印を変える counter: 予算の判定（digest ごと）は exact、usage.counter は連結の計測の heuristic", async () => {
    const lengthDependent: TokenCounter = {
      count: (text) => ({ tokens: 3, counter: text.length > 10 ? "heuristic" : "exact" }),
    };
    const { runtime, stores } = buildRuntime({ tokenCounter: lengthDependent });
    for (const digest of ["aaaaaaaaaa", "bbbbbbbbbb"]) {
      await createEmbeddedMemory(stores, [1, 0], { digest, contentHash: digest });
    }
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 4 },
    });
    expect(result.memories).toHaveLength(1);
    expect(result.usage.counter).toBe("heuristic");
    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
  });
});

// `wantsAnn` はクエリの中身と関係なく真なので、空クエリでも ANN の trace は `executed: false` で積まれる。`annWindowUnderfilled` から `candidateGenerationExecuted` を外すと、走っていない段に `annReturnedFewerThanReachable: true` が付く。
describe("recall() — ANN が走っていない recall（空クエリ）には annReturnedFewerThanReachable を足さない（ADR 0285 約束3）", () => {
  it("scope に ready の記憶が3件あっても、空クエリの ANN の trace の detail にキーが無く、ann_unreached も出ない", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(0);
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, {});

    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.channel === "ann",
    );
    // 検算: ANN の trace は積まれていて、走っていない（この歯が何も見ていない、にならないため）。
    expect(annTrace).toBeDefined();
    expect(annTrace?.executed).toBe(false);
    expect(annTrace?.detail).not.toHaveProperty("annReturnedFewerThanReachable");
    expect(annTrace?.detail).not.toHaveProperty("annReachableLowerBound");
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
  });
});
