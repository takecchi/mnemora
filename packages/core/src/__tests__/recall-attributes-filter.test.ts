import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { LexicalFilter } from "../interfaces/lexical-store.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RecallQuery.attributes`（Issue #152/#153、ADR 0308）の歯。
 *
 * `recall-subjectless-filter.test.ts`（ADR 0286）・`recall-validity.test.ts`（ADR 0164）と
 * 同型の構え:
 * 1. 配線の歯——段1（ANN・語彙）と段3.5（連想枠）の filter に `attributes` が渡ること。
 * 2. 母集合を実際に減らす本命の歯——AND 等値、キー不一致・値不一致・キー不在のどれも落ちる。
 * 3. 空オブジェクトは「絞り込み無し」（省略と同じ）。
 * 4. `totalInScope` はこの絞り込みの内側だけを数える。**`omitted` には出ない**
 *    （`subjectId`/`tenant` と同じ「スコープの外側の境界」——ADR 0308 決定6）。
 * 5. `RecalledMemory.attributes` が返り値に載る。
 * 6. adapter が `attributes` を無視しても安全（取りこぼしはあるが混入は無い）——
 *    `AttributesFilterStrippingVectorStore` で段1の絞りを剥がし、後置フィルタ
 *    （`survivesAttributesFilter`）だけで正しく絞れることを確かめる。
 *
 * `packages/core` 自身のテストなので `@mnemora/testkit` には依存しない。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(vectorStoreOverride?: (fvs: VectorStore) => VectorStore) {
  const stores = createFakeRuntimeStores();
  const vectorStore = vectorStoreOverride
    ? vectorStoreOverride(stores.vectorStore)
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

function captureVectorFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const captured: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (c, space, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(c, space, query, opts);
  };
  return captured;
}

function captureLexicalFilters(
  stores: ReturnType<typeof createFakeRuntimeStores>,
): LexicalFilter[] {
  const captured: LexicalFilter[] = [];
  const originalSearch = stores.lexicalStore.search.bind(stores.lexicalStore);
  stores.lexicalStore.search = async (c, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(c, query, opts);
  };
  return captured;
}

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

// ---------------------------------------------------------------------------
// 1. 配線の歯。
// ---------------------------------------------------------------------------

describe("recall() — 段1の filter に attributes が載ること（配線の歯、Issue #152/#153）", () => {
  it("RecallQuery.attributes が VectorStore.search / LexicalStore.search の opts.filter.attributes に渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);
    const lexicalFilters = captureLexicalFilters(stores);

    await runtime.recall(ctx, {
      vector: [1, 0],
      text: "本文",
      channels: ["ann", "lexical"],
      attributes: { visibility: "internal" },
    });

    expect(vectorFilters[0]?.attributes).toEqual({ visibility: "internal" });
    expect(lexicalFilters[0]?.attributes).toEqual({ visibility: "internal" });
  });

  it("attributes を渡さないときは opts.filter.attributes も undefined のまま渡る（既定動作を壊さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0] });

    expect(vectorFilters[0]?.attributes).toBeUndefined();
  });

  it("空オブジェクト（{}）は「絞り込み無し」——渡したときと1バイトも変わらない", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], attributes: {} });

    expect(vectorFilters[0]?.attributes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 本命の歯: 母集合を実際に減らす。
// ---------------------------------------------------------------------------

describe("recall() — attributes が実際に候補を落とす（AND 等値、Issue #152/#153）", () => {
  it("渡したキーと同じ値を持つ Memory だけが返る", async () => {
    const { runtime, stores } = buildRuntime();
    const matching = await createEmbeddedMemory(stores, [1, 0], {
      digest: "matching",
      attributes: { visibility: "internal" },
    });
    const mismatching = await createEmbeddedMemory(stores, [1, 0], {
      digest: "mismatching",
      attributes: { visibility: "public" },
    });
    const missing = await createEmbeddedMemory(stores, [1, 0], {
      digest: "missing",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      attributes: { visibility: "internal" },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(mismatching.id);
    expect(ids).not.toContain(missing.id);
  });

  it("複数キーは AND——すべて一致する Memory だけが残る", async () => {
    const { runtime, stores } = buildRuntime();
    const both = await createEmbeddedMemory(stores, [1, 0], {
      digest: "both",
      attributes: { visibility: "internal", region: "jp" },
    });
    const onlyOne = await createEmbeddedMemory(stores, [1, 0], {
      digest: "only-one",
      attributes: { visibility: "internal", region: "us" },
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      attributes: { visibility: "internal", region: "jp" },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(both.id);
    expect(ids).not.toContain(onlyOne.id);
  });

  it("attributes で落ちた Memory は omitted に出ない（subjectId/tenant と同じスコープの外側、ADR 0308 決定6）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "matching",
      attributes: { visibility: "internal" },
    });
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "mismatching",
      attributes: { visibility: "public" },
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      attributes: { visibility: "internal" },
    });

    expect(result.omitted).toEqual([]);
    // totalInScope はこの絞り込みの内側（1件）だけを数える——2件目は「そもそも問うていない」。
    expect(result.index.totalInScope).toBe(1);
  });

  it("RecalledMemory.attributes に、その Memory の attributes がそのまま載る", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "matching",
      attributes: { visibility: "internal" },
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      attributes: { visibility: "internal" },
    });

    expect(result.memories[0]?.attributes).toEqual({ visibility: "internal" });
  });

  it("attributes を持たない Memory（旧データ相当）は RecalledMemory.attributes が {} になる", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "no-attrs" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories[0]?.attributes).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. adapter がこの欄を無視しても安全である（取りこぼしはあるが、混入は無い）。
// `FakeVectorStore` は attributes を実際に見る実装であり、`AttributesFilterStrippingVectorStore`
// で段1の絞りを剥がすことで「対応していない adapter」を模す（`recall-subjectless-filter.test.ts`
// の `SubjectFilterStrippingVectorStore` と同型）。
// ---------------------------------------------------------------------------

class AttributesFilterStrippingVectorStore implements VectorStore {
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

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    const { attributes: _attributes, ...stripped } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 後置フィルタ（survivesAttributesFilter）が段1の絞りを剥がしても正しく絞る", () => {
  it("adapter が attributes を無視しても、後置フィルタが混入を防ぐ", async () => {
    const { runtime, stores } = buildRuntime(
      (fvs) => new AttributesFilterStrippingVectorStore(fvs),
    );
    const matching = await createEmbeddedMemory(stores, [1, 0], {
      digest: "matching",
      attributes: { visibility: "internal" },
    });
    const mismatching = await createEmbeddedMemory(stores, [1, 0], {
      digest: "mismatching",
      attributes: { visibility: "public" },
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      attributes: { visibility: "internal" },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(mismatching.id);
  });
});

// ---------------------------------------------------------------------------
// 4. 連想枠（段3.5）にも同じ絞りが掛かる（ADR 0172/#347 の見落としを繰り返さない）。
// ---------------------------------------------------------------------------

/** Q=[1,0] に対して類似度 0.7071——段1で拾われ、連想のアンカーになる。 */
const ANCHOR_VECTOR = [0.70710678, 0.70710678];
/** アンカーとの類似度は 0.7071 だが、クエリとの類似度は0——連想枠でしか返ってこない。 */
const ASSOCIATED_VECTOR = [0, 1];
const ASSOCIATION = { maxCount: 5, anchorCount: 1 } as const;

describe("recall() — 連想枠（段3.5）にも attributes が掛かる（Issue #152/#153、ADR 0172 の再発防止）", () => {
  it("連想用 search() の filter にも段1と同じ attributes が渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);
    // アンカー自身も attributes に一致していないと後置フィルタで落ち、連想の起点が
    // 無くなって段3.5 の search() 自体が呼ばれない（下の「一致しない連想候補は返らない」
    // 歯と同じ理由）。
    await createEmbeddedMemory(stores, ANCHOR_VECTOR, {
      digest: "アンカー",
      attributes: { visibility: "internal" },
    });
    await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, { digest: "連想" });

    await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      attributes: { visibility: "internal" },
    });

    expect(vectorFilters).toHaveLength(2);
    expect(vectorFilters[0]?.attributes).toEqual({ visibility: "internal" });
    expect(vectorFilters[1]?.attributes).toEqual({ visibility: "internal" });
  });

  it("attributes が一致しない連想候補は返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, {
      digest: "アンカー",
      attributes: { visibility: "internal" },
    });
    const associated = await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, {
      digest: "連想",
      attributes: { visibility: "public" },
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      attributes: { visibility: "internal" },
    });

    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });
});
