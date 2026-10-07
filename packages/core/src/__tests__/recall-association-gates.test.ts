import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
/** +100年。壁時計では絶対に沈まない（`recall-decay-gate.test.ts` と同じ道具立て）。 */
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);

const ANCHOR_VECTOR = [0.70710678, 0.70710678];
/** 段1では below_threshold だが、アンカーとの類似度で連想枠でだけ届く位置。結果に現れたら段3.5 を通った証拠になる。 */
const ASSOCIATED_VECTOR = [0, 1];

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

async function seedAnchorAndAssociated(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  associatedOverrides: Partial<NewMemory>,
  anchorOverrides: Partial<NewMemory> = {},
): Promise<{ anchor: Memory; associated: Memory }> {
  const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, {
    digest: "アンカー本文",
    ...anchorOverrides,
  });
  const associated = await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, {
    digest: "連想本文",
    ...associatedOverrides,
  });
  return { anchor, associated };
}

function captureFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const captured: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (c, space, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(c, space, query, opts);
  };
  return captured;
}

const ASSOCIATION = { maxCount: 5, anchorCount: 1 } as const;

describe("recall() — 連想用 search() の filter が段1の ANN と同じゲート欄を持つ（配線の歯、Issue #347）", () => {
  it("段1と段3.5の filter の decayFloorAtAfter / decayFloorSeqAfter / decayFloorAnyAxis / validAt が一致する", async () => {
    const { runtime, stores } = buildRuntime();
    await seedAnchorAndAssociated(stores, {});
    const filters = captureFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], limit: 10, association: ASSOCIATION });

    expect(filters).toHaveLength(2);
    const [stage1, association] = filters;
    expect(association?.decayFloorAtAfter).toEqual(stage1?.decayFloorAtAfter);
    expect(association?.decayFloorSeqAfter).toEqual(stage1?.decayFloorSeqAfter);
    expect(association?.decayFloorAnyAxis).toEqual(stage1?.decayFloorAnyAxis);
    expect(association?.validAt).toEqual(stage1?.validAt);
    // 既定では実際に「いま」が載っている（両方 undefined で一致、を通してしまわないため）。
    expect(association?.decayFloorAtAfter).toEqual(NOW);
    expect(association?.validAt).toEqual(NOW);
  });

  it("includeFullyDecayed / includeOutsideValidity を渡すと、連想用 filter でもゲートが外れる", async () => {
    const { runtime, stores } = buildRuntime();
    await seedAnchorAndAssociated(stores, {});
    const filters = captureFilters(stores);

    await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeFullyDecayed: true,
      includeOutsideValidity: true,
    });

    expect(filters).toHaveLength(2);
    expect(filters[1]?.decayFloorAtAfter).toBeUndefined();
    expect(filters[1]?.decayFloorSeqAfter).toBeUndefined();
    expect(filters[1]?.decayFloorAnyAxis).toBe(false);
    expect(filters[1]?.validAt).toBeUndefined();
  });
});

describe("recall() — 連想枠に忘却ゲートが掛かる（Issue #347）", () => {
  it("完全に減衰しきった記憶は、連想枠からも返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: new Date(NOW.getTime() - 1_000), // 1秒前に沈んでいる
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
  });

  it("対照: 同じ配置で沈んでいなければ、連想枠から返る（歯が「連想が常に空」で通っていないことの検算）", async () => {
    const { runtime, stores } = buildRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: FAR_FUTURE,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("includeFullyDecayed: true を渡すと、連想枠でも減衰しきったものが返る（opt-out は連想枠でも尊重される）", async () => {
    const { runtime, stores } = buildRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeFullyDecayed: true,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });
});

describe("recall() — 連想枠の忘却ゲートが活動時計の軸も見る（ADR 0165 決めたこと12、Issue #347）", () => {
  it("'activity' のテナントでは、壁時計が遠い未来でも decayFloorSeq を割った記憶は連想枠から返らない", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない
        decayBaseSeq: 0,
        decayFloorSeq: 0, // nowSeq(=0) ちょうど。狭義の `>` が効かず沈んでいる
      },
      { decayFloorAt: FAR_FUTURE, decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("対照: 同じ記憶を 'wall' のテナントで引くと、活動時計の床は無視され連想枠から返る", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 0,
      },
      { decayFloorAt: FAR_FUTURE },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });

  it("'either' は OR（最も緩い）: 活動時計は沈んでいても壁時計が生きていれば連想枠から返る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計は生きている
        decayBaseSeq: 0,
        decayFloorSeq: 0, // 活動時計は沈んでいる
      },
      { decayFloorAt: FAR_FUTURE, decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });
});

describe("recall() — 連想枠に validAt ゲートが掛かる（Issue #347）", () => {
  it("期限切れ（validUntil が過去）の記憶は、連想枠からも返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, {
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "expired", count: 1 }),
    );
  });

  it("未発効（validFrom が未来）の記憶は、連想枠からも返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, {
      validFrom: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "not_yet_valid", count: 1 }),
    );
  });

  it("includeOutsideValidity: true を渡すと、連想枠でも期限切れの記憶が返る（opt-out）", async () => {
    const { runtime, stores } = buildRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(stores, {
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeOutsideValidity: true,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("過去の validAt を指定すると、その時点で真だった（いまは期限切れの）記憶が連想枠から返る", async () => {
    const { runtime, stores } = buildRuntime();
    const expiredAt = new Date(NOW.getTime() - 1_000 * 60 * 60 * 24); // 1日前に失効
    const { associated } = await seedAnchorAndAssociated(stores, { validUntil: expiredAt });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      validAt: new Date(expiredAt.getTime() - 1_000), // まだ真だった時刻
    });

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });
});

describe("recall() — 連想枠から superseded は引き続き返らない（回帰、Issue #347 で壊していないこと）", () => {
  it("status='superseded' の記憶は、連想の近傍に居ても返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, { status: "superseded" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "superseded", count: 1 }),
    );
  });

  it("includeFullyDecayed: true を渡しても superseded は返らない（ゲートの軸が別であることの検算）", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, { status: "superseded" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeFullyDecayed: true,
      includeOutsideValidity: true,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });
});

// 連想用 search()（2本目以降）からだけゲートの欄を剥がす。段1の押し下げは効かせたまま、連想用 search() だけが契約を破った状況を作るため。

class AssociationGateStrippingVectorStore implements VectorStore {
  private searchCount = 0;

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

  getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: Parameters<NonNullable<VectorStore["getVectors"]>>[2],
  ): ReturnType<NonNullable<VectorStore["getVectors"]>> {
    if (this.inner.getVectors === undefined) {
      throw new Error("inner VectorStore lacks getVectors");
    }
    return this.inner.getVectors(ctx, space, memoryIds);
  }

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    this.searchCount += 1;
    if (this.searchCount === 1) {
      return this.inner.search(ctx, space, query, opts);
    }
    const {
      decayFloorAtAfter: _a,
      decayFloorSeqAfter: _b,
      decayFloorAnyAxis: _c,
      validAt: _d,
      ...stripped
    } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 連想用 adapter がゲートを無視しても、後置フィルタが同じ述語で拾う（Issue #347）", () => {
  it("減衰しきった記憶は、連想用 search() がゲートを剥がしても返らない", async () => {
    const { runtime, stores } = buildRuntime(
      (s) => new AssociationGateStrippingVectorStore(s.vectorStore),
    );
    const { associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    // count がちょうど 1 であることを固定する（`not.toContainEqual` ではない）。連想枠の後置や段1の後置が
    // 段5の集約とは別に足し込むと 2 になり、二重計上を検出できる。
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
  });

  /** 押し下げが効く通常の配線では連想用 search() が先に候補を落とし、後置の述語（活動時計の軸）が露出しない。ゲートを剥がしたこの配置でだけ後置が検査される。 */
  it("'activity' のテナントで、連想用 search() がゲートを剥がしても活動時計で沈んだ記憶は返らない", async () => {
    const { runtime, stores } = buildRuntime(
      (s) => new AssociationGateStrippingVectorStore(s.vectorStore),
    );
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない——活動時計の軸だけが落とせる
        decayBaseSeq: 0,
        decayFloorSeq: 0,
      },
      { decayFloorAt: FAR_FUTURE, decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("期限切れの記憶も、連想用 search() がゲートを剥がしても返らない", async () => {
    const { runtime, stores } = buildRuntime(
      (s) => new AssociationGateStrippingVectorStore(s.vectorStore),
    );
    const { associated } = await seedAnchorAndAssociated(stores, {
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });
});

describe("recall() — 連想枠の maxCount 切り捨てが omitted.over_limit として名乗る（Issue #375 / ADR 0188）", () => {
  it("連想候補が maxCount を超えると、超過分だけ over_limit(stage: 'association') として報告される", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー本文" });
    const associatedCount = ASSOCIATION.maxCount + 3; // maxCount(5) より3件多く用意する
    for (let i = 0; i < associatedCount; i++) {
      await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, { digest: `連想本文${i}` });
    }

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    const associationMembers = result.memories.filter((m) => m.retrievedVia === "association");
    expect(associationMembers).toHaveLength(ASSOCIATION.maxCount);
    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "association",
      count: associatedCount - ASSOCIATION.maxCount,
      countKind: "exact",
    });
  });

  it("連想候補が maxCount 以下なら over_limit(stage: 'association') は積まれない（鳴ってはいけない側）", async () => {
    const { runtime, stores } = buildRuntime();
    await seedAnchorAndAssociated(stores, {}); // 連想候補は1件だけ、maxCount(5)未満

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.omitted.some((o) => o.kind === "over_limit" && o.stage === "association")).toBe(
      false,
    );
    expect(result.omitted.some((o) => o.kind === "over_limit")).toBe(false);
  });
});
