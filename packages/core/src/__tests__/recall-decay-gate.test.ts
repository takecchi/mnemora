import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { runRecall } from "../recall-runtime.js";
import type { RecallRuntimeDeps } from "../recall-runtime.js";
import type { RecallQuery } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(opts: { vectorStoreOverride?: (fvs: FakeVectorStore) => VectorStore } = {}) {
  const stores = createFakeRuntimeStores();
  const vectorStore = opts.vectorStoreOverride
    ? opts.vectorStoreOverride(stores.vectorStore)
    : stores.vectorStore;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
    lexicalStore: stores.lexicalStore,
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

function captureFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const capturedFilters: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (ctx, space, query, opts) => {
    capturedFilters.push(opts.filter);
    return originalSearch(ctx, space, query, opts);
  };
  return capturedFilters;
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10; // 長い half-life。既定では減衰しない。
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
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
    embeddingStatus: "pending",
    ...overrides,
  };
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

describe("recall() — 段1の filter に decayFloorAtAfter が載ること（配線の歯、ADR 0153）", () => {
  it("既定（includeFullyDecayed 未指定）では VectorStore.search の opts.filter.decayFloorAtAfter に「いま」が渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.decayFloorAtAfter).toEqual(NOW);
  });

  it("includeFullyDecayed: true では decayFloorAtAfter は undefined のまま渡る（ADR 0153 以前の挙動に戻す）", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], includeFullyDecayed: true });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.decayFloorAtAfter).toBeUndefined();
  });
});

describe("recall() — 忘却ゲートが実際に候補を落とす（ANN チャンネル、ADR 0153）", () => {
  it("decayFloorAt が過去（減衰しきった）記憶は既定では返らず、omitted にも explain にも黙って消えない", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "alive",
      decayFloorAt: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(alive.id);
    expect(ids).not.toContain(decayed.id);

    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });

    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["decayGate"]).toBe("pushed_down");
  });

  it("includeFullyDecayed: true を渡すと、減衰しきった記憶も戻る（明示的な逃げ道、北極星の問い2）", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      includeFullyDecayed: true,
    });

    expect(result.memories.map((m) => m.memoryId)).toContain(decayed.id);
    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["decayGate"]).toBe("disabled");
  });

  it("境界: decayFloorAt がちょうど now と同じ記憶は含まれない（狭義の `>`、VectorFilter.decayFloorAtAfter と同じ境界）", async () => {
    const { runtime, stores } = buildRuntime();
    const onBoundary = await createEmbeddedMemory(stores, [1, 0], {
      digest: "on-boundary",
      decayFloorAt: NOW,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(onBoundary.id);
  });
});

// `LexicalFilter` は `decayFloorAtAfter` を持たないので、語彙チャンネルでは core の後置フィルタだけがゲートを担う。

describe("recall() — 忘却ゲートが語彙チャンネルにも同じ述語で効く（後置フィルタ、ADR 0153）", () => {
  it("語彙チャンネルだけを使っても、減衰しきった記憶は既定では返らず、omitted に filtered(decayed) が実測件数で出る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "decayed-lexical",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: new Date(NOW.getTime() - 1_000),
      }),
    );
    const alive = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "alive-lexical",
        content: "gemstone の価格改定メモ",
        decayFloorAt: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365),
      }),
    );

    const result = await runtime.recall(ctx, {
      text: "gemstone",
      channels: ["lexical"],
      limit: 10,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(alive.id);
    expect(ids).toHaveLength(1);

    // `FakeLexicalStore` は decayed も返し、core の後置フィルタがそれを落とす。件数は後置フィルタからではなく
    // 段5の `aggregateScope` から出す（両方から数えると二重計上になる）。
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });

    const lexicalTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "lexical",
    );
    expect(lexicalTrace?.detail?.["decayGate"]).toBe("post_filtered");
  });

  it("includeFullyDecayed: true では語彙チャンネルも減衰しきった記憶を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "decayed-lexical",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: new Date(NOW.getTime() - 1_000),
      }),
    );

    const result = await runtime.recall(ctx, {
      text: "gemstone",
      channels: ["lexical"],
      limit: 10,
      includeFullyDecayed: true,
    });

    expect(result.memories.map((m) => m.memoryId)).toContain(decayed.id);
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
    const lexicalTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "lexical",
    );
    expect(lexicalTrace?.detail?.["decayGate"]).toBe("disabled");
  });
});

// `DecayFloorAtAfterStrippingVectorStore` は `opts.filter` から `decayFloorAtAfter` だけを剥がして委譲する。
// 段1の adapter が filter を適用しない状況を再現し、押し下げと後置フィルタが同じ述語であることを確かめる。

class DecayFloorAtAfterStrippingVectorStore implements VectorStore {
  constructor(private readonly inner: VectorStore) {}

  upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["upsert"]>[2],
    vector: number[],
  ): ReturnType<VectorStore["upsert"]> {
    return this.inner.upsert(ctx, space, memoryId, vector);
  }

  delete(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["delete"]>[2],
  ): ReturnType<VectorStore["delete"]> {
    return this.inner.delete(ctx, space, memoryId);
  }

  deleteAcrossSpaces(
    ctx: Ctx,
    memoryIds: Parameters<VectorStore["deleteAcrossSpaces"]>[1],
  ): ReturnType<VectorStore["deleteAcrossSpaces"]> {
    return this.inner.deleteAcrossSpaces(ctx, memoryIds);
  }

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    const { decayFloorAtAfter: _decayFloorAtAfter, ...stripped } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 押し下げと後置フィルタは同じ述語であることの検算（ADR 0153 決めたこと3）", () => {
  it("段1の adapter が decayFloorAtAfter を無視しても、core の後置フィルタが同じ述語で拾う（多層防御）", async () => {
    const { runtime, stores } = buildRuntime({
      vectorStoreOverride: (fvs) => new DecayFloorAtAfterStrippingVectorStore(fvs),
    });
    const decayed = await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed-despite-broken-adapter",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(decayed.id);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
  });

  it("⭐ 通常の配線（adapter が正しく押し下げる）でも、壊れた adapter のときと同じ件数を名乗る（段1と段5が同じ述語を見ていることの検算）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "alive",
      decayFloorAt: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["decayGate"]).toBe("pushed_down");
  });

  it("(c) includeFullyDecayed: true のときは、この omission が積まれない（ゲートを外したのだから落ちていない）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      includeFullyDecayed: true,
      scoreThreshold: 0,
    });

    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });

  it("⭐ 件数は scope に従う: subjectId で絞ると、その subject の減衰件数だけを数える", async () => {
    const { runtime, stores } = buildRuntime();
    const past = new Date(NOW.getTime() - 1_000);
    for (const subjectId of ["alice", "alice", "bob"]) {
      await createEmbeddedMemory(stores, [1, 0], { subjectId, decayFloorAt: past });
    }

    const scoped = await runtime.recall(
      { tenantId: "tenant-1", subjectId: "alice" },
      { vector: [1, 0], limit: 10 },
    );
    expect(scoped.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 2,
      countKind: "exact",
    });

    const wholeTenant = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(wholeTenant.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 3,
      countKind: "exact",
    });
  });
});

// 下の歯は壁時計を永久に生きる設定にして `decayFloorSeq`/`decayBaseSeq` だけを操作する。`halfLifeRecalls` を載せないのは、
// 段2の `computeDecay` が両方揃わないと壁時計へフォールバックするため（段2のスコア変動を混ぜない）。

const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100); // +100年、壁時計では絶対に沈まない

describe("recall() — 忘却ゲートの時計選択（ADR 0165 決めたこと1）", () => {
  it("'wall'（既定）のテナントでは decayFloorSeq が割れていても無視する", async () => {
    const { runtime, stores } = buildRuntime();
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "wall-alive-activity-dead",
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: 0, // 活動時計では既に沈んでいる値（nowSeq=0 ちょうど。負数は Postgres の CHECK が拒むので使わない。ADR 0493）
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
  });

  it("'activity' のテナントでは壁時計を無視する: decayFloorAt が遠い未来でも decayFloorSeq を割れば除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const dead = await createEmbeddedMemory(stores, [1, 0], {
      digest: "wall-alive-activity-dead",
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: 0, // nowSeq(=0)ちょうどで狭義の`>`が効かず既に沈んでいる
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(dead.id);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
  });

  it("'activity' のテナントでは decayFloorSeq が nowSeq を上回っていれば生き残る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "activity-alive",
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: 100,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });

  it("'activity' のテナントで decayFloorSeq が NULL（この軸に床が無い）なら常に生き残る（ADR 0165 決めたこと4）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "activity-no-floor",
      decayFloorAt: new Date(NOW.getTime() - 1_000), // 壁時計では既に沈んでいるが 'activity' なので無関係
      decayBaseSeq: null,
      decayFloorSeq: null,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
  });

  it("'either' はOR: 壁時計は生きているが活動時計は沈んでいても通る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "either-wall-alive",
      decayFloorAt: FAR_FUTURE, // 壁時計は生きている
      decayBaseSeq: 0,
      decayFloorSeq: 0, // 活動時計は沈んでいる(nowSeq=0で狭義の`>`が効かない)
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
    // 'either' は OR（最も緩い）: 壁時計が生きているので落ちていない。集約側で AND/OR を取り違えると 1 件を名乗って赤くなる。
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });

  it("'either' はOR: 活動時計は生きているが壁時計は沈んでいても通る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "either-activity-alive",
      decayFloorAt: new Date(NOW.getTime() - 1_000), // 壁時計は沈んでいる
      decayBaseSeq: 0,
      decayFloorSeq: 100, // 活動時計は生きている
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });

  it("'either' はOR: 両方沈んでいれば除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const dead = await createEmbeddedMemory(stores, [1, 0], {
      digest: "either-both-dead",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
      decayBaseSeq: 0,
      decayFloorSeq: 0,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(dead.id);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
  });

  it("explain.stages の detail.clock が実際に使ったテナントの時計を名乗る（'activity'/'either'、北極星の問い3）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    await createEmbeddedMemory(stores, [1, 0], { digest: "m", decayFloorAt: FAR_FUTURE });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["clock"]).toBe("activity");
  });
});

describe("recall() — 語彙チャンネルの後置フィルタにも活動時計が掛かる（ADR 0165 決めたこと12、忘れやすい非対称）", () => {
  it("'activity' のテナントで、語彙チャンネルだけを使っても decayFloorSeq を割れば除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "lexical-activity-dead",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない
        decayBaseSeq: 0,
        decayFloorSeq: 0, // 活動時計では既に沈んでいる
      }),
    );
    const alive = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "lexical-activity-alive",
        content: "gemstone の価格改定メモ",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 100,
      }),
    );

    const result = await runtime.recall(ctx, {
      text: "gemstone",
      channels: ["lexical"],
      limit: 10,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(alive.id);
    expect(ids).toHaveLength(1);
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });
});

describe("recall() — 非破壊性: RecallRuntimeDeps.tenantSettingsStore を省略しても 'wall' として動く（ADR 0165 決めたこと13）", () => {
  it("tenantSettingsStore を渡さない runRecall() は、activity 列があっても壁時計だけで判定する", async () => {
    const stores = createFakeRuntimeStores();
    const deps: RecallRuntimeDeps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      embeddingProvider: stores.embeddingProvider,
      clock: { now: () => NOW },
      tokenCounter: {
        count: (text: string) => ({ tokens: text.length, counter: "heuristic" as const }),
      },
      // tenantSettingsStore は省略——外部の呼び出し側を壊さないことの歯そのもの。
    };
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "no-tenant-settings-store",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 0, // 活動時計では沈んでいる値（nowSeq=0 ちょうど。負数は Postgres の CHECK が拒む。ADR 0493）(読まれれば除外されるはず)
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    const result = await runRecall(ctx, { vector: [1, 0], limit: 10 }, deps);

    expect(result.memories.map((m) => m.memoryId)).toContain(memory.id);
    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["clock"]).toBe("wall");
  });
});

describe("recall() — ⭐ 'activity' 単独で、素通りされ続けた記憶は壁時計より速く沈む（多忙なテナント）", () => {
  /**
   * 意図的に語彙チャンネルを使う（ANN ではない）: `LexicalFilter` は `decayFloorAtAfter`/`decayFloorSeqAfter` を持たず、
   * 段1の押し下げに助けられないので、後置フィルタ（`survivesDecayGate`）だけがこの歯を通す。
   * ANN だと段1の押し下げが先に候補を落とし、後置の述語の変異に気づけない。
   */
  it("壁時計なら生きているはずの記憶が、activity_seq の前進（recall の繰り返し）だけで沈む", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");

    // decayBaseSeq=0, decayFloorSeq=3: nowSeq=3 で沈む。壁時計側は FAR_FUTURE で絶対に沈まない設定にした対照条件。
    const target = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "busy-tenant-target",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 3,
      }),
    );
    const query: RecallQuery = { text: "gemstone", channels: ["lexical"], limit: 10 };

    const first = await runtime.recall(ctx, query);
    expect(first.memories.map((m) => m.memoryId)).toContain(target.id);

    const second = await runtime.recall(ctx, query);
    expect(second.memories.map((m) => m.memoryId)).toContain(target.id);

    const third = await runtime.recall(ctx, query);
    expect(third.memories.map((m) => m.memoryId)).toContain(target.id);

    const fourth = await runtime.recall(ctx, query);
    expect(fourth.memories.map((m) => m.memoryId)).not.toContain(target.id);
    expect(fourth.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });

  it("対照条件: 同じ4回の recall を 'wall' のテナントに対して行うと、壁時計だけを見るので何回呼んでも沈まない", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "wall-tenant-target",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 3,
      }),
    );
    const query: RecallQuery = { text: "gemstone", channels: ["lexical"], limit: 10 };

    for (let i = 0; i < 4; i += 1) {
      const result = await runtime.recall(ctx, query);
      expect(result.memories.map((m) => m.memoryId)).toContain(target.id);
    }

    expect(await stores.tenantSettingsStore.getActivitySeq(ctx)).toBe(0);
  });
});
