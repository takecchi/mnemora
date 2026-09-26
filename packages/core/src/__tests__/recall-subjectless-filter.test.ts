import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { LexicalFilter } from "../interfaces/lexical-store.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

/**
 * Issue #608 項目③(b) / [ADR 0286](../../../docs/decisions/0286-recall-include-subjectless.md):
 * `RecallQuery.includeSubjectless` — `ctx.subjectId` の等値絞りを `subjectId: null`
 * （主題なし）まで広げる opt-in。
 *
 * `recall-subject-filter.test.ts`（ADR 0023）・`recall-period-filter.test.ts`（ADR 0059）と
 * 同型の3段構え:
 * 1. 配線の歯——`RecallQuery.includeSubjectless` が段1の `VectorFilter`/`LexicalFilter` に
 *    そのまま渡ること。
 * 2. **adapter がこの欄を無視しても安全であること**——`includeSubjectless` を知らない
 *    「他社 adapter」を `IncludeSubjectlessIgnoringVectorStore` で再現する。この状態で
 *    `includeSubjectless: true` を渡しても、主題なしの Memory を取りこぼすだけで、
 *    別の subject の Memory が混ざることは無い。
 *    （当初は素の `FakeVectorStore` がこの欄を参照していなかったので、それをそのまま
 *    使っていた。Issue #948 で Fake がこの欄を適用するようになったため、ラッパに置き換えた。）
 * 3. **後置フィルタ本体の歯**——`PeriodStrippingVectorStore`（ADR 0059）と同型の
 *    `SubjectFilterStrippingVectorStore` で段1の絞りを剥がし、`recall-runtime.ts` の
 *    `survivesSubjectFilter` だけで正しく絞れることを確かめる。
 *
 * `packages/core` 自身のテストなので `@mnemora/testkit` には依存しない。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");

function buildRuntime(
  vectorStoreOverride?: (fvs: FakeVectorStore) => VectorStore,
  opts?: { wireLexicalStore?: boolean },
) {
  const stores = createFakeRuntimeStores();
  const vectorStore = vectorStoreOverride
    ? vectorStoreOverride(stores.vectorStore)
    : stores.vectorStore;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
    lexicalStore: opts?.wireLexicalStore === true ? stores.lexicalStore : undefined,
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
  stores.vectorStore.search = async (ctx, space, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(ctx, space, query, opts);
  };
  return captured;
}

function captureLexicalFilters(
  stores: ReturnType<typeof createFakeRuntimeStores>,
): LexicalFilter[] {
  const captured: LexicalFilter[] = [];
  const originalSearch = stores.lexicalStore.search.bind(stores.lexicalStore);
  stores.lexicalStore.search = async (ctx, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(ctx, query, opts);
  };
  return captured;
}

describe("recall() — 段1の filter に includeSubjectless が載ること（配線の歯、Issue #608 ③(b) / ADR 0286）", () => {
  it("query.includeSubjectless: true が VectorStore.search の opts.filter.includeSubjectless に渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureVectorFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1", subjectId: "user-42" };
    await runtime.recall(ctx, { vector: [1, 0], includeSubjectless: true });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.subjectId).toBe("user-42");
    expect(capturedFilters[0]?.includeSubjectless).toBe(true);
  });

  it("includeSubjectless を渡さないときは opts.filter.includeSubjectless も undefined のまま渡る（既定動作を壊さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureVectorFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1", subjectId: "user-42" };
    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.includeSubjectless).toBeUndefined();
  });

  it("語彙チャンネルの LexicalStore.search にも同じ値が渡る", async () => {
    const { runtime, stores } = buildRuntime(undefined, { wireLexicalStore: true });
    const capturedFilters = captureLexicalFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1", subjectId: "user-42" };
    await runtime.recall(ctx, {
      text: "hello",
      channels: ["lexical"],
      includeSubjectless: true,
    });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.subjectId).toBe("user-42");
    expect(capturedFilters[0]?.includeSubjectless).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Memory の下ごしらえ（recall-period-filter.test.ts と同じ形）。
// ---------------------------------------------------------------------------

const ctx: Ctx = { tenantId: "tenant-1", subjectId: "user-a" };

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
// 2. adapter がこの欄を無視しても安全である（取りこぼしはあるが、混入は無い）。
// `IncludeSubjectlessIgnoringVectorStore` は `includeSubjectless` だけを剥がし、
// `subjectId` の厳密一致だけを見る「includeSubjectless を知らない adapter」を再現する
// （Issue #948 までは素の `FakeVectorStore` がこの形だった）。
// ---------------------------------------------------------------------------

class IncludeSubjectlessIgnoringVectorStore implements VectorStore {
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
    // 🔑 includeSubjectless「だけ」を剥がす。subjectId を含め他は素通し。
    const { includeSubjectless: _includeSubjectless, ...stripped } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — includeSubjectless を無視する adapter でも、別 subject が混ざることは無い", () => {
  it("includeSubjectless を知らない adapter では、includeSubjectless: true でも主題なしの Memory は返らない（取りこぼし。混入ではない）", async () => {
    const { runtime, stores } = buildRuntime(
      (fvs) => new IncludeSubjectlessIgnoringVectorStore(fvs),
    );
    const query = [1, 0];

    const subjectAMemory = await createEmbeddedMemory(stores, query, { subjectId: "user-a" });
    await createEmbeddedMemory(stores, query, { subjectId: null });
    await createEmbeddedMemory(stores, query, { subjectId: "user-b" });

    const result = await runtime.recall(ctx, { vector: query, includeSubjectless: true });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(subjectAMemory.id);
    // 🔴 取りこぼし: adapter が `includeSubjectless` を無視して subjectId 厳密一致のまま
    // 候補を絞るため、主題なしの Memory は段1の窓に一度も現れず、後置フィルタも
    // 存在しないものを復活させられない。
    expect(ids).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. 後置フィルタ本体の歯。段1の絞りを剥がし、`survivesSubjectFilter` だけで
// 正しく絞れることを確かめる（`PeriodStrippingVectorStore` と同型）。
//
// ⛔ 本番コード（recall-runtime.ts / vector-store.ts）は1文字も変えない——
// ラッパはこの test ファイルの中に閉じている。
// ---------------------------------------------------------------------------

class SubjectFilterStrippingVectorStore implements VectorStore {
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
    // 🔑 subjectId/includeSubjectless「だけ」を剥がす。他は素通し。
    const {
      subjectId: _subjectId,
      includeSubjectless: _includeSubjectless,
      ...stripped
    } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 後置フィルタ（survivesSubjectFilter）が includeSubjectless を正しく適用する", () => {
  it("includeSubjectless: true なら、一致する subject と主題なし（null）の両方が返り、別 subject は返らない", async () => {
    const { runtime, stores } = buildRuntime((fvs) => new SubjectFilterStrippingVectorStore(fvs));
    const query = [1, 0];

    const subjectAMemory = await createEmbeddedMemory(stores, query, { subjectId: "user-a" });
    const subjectlessMemory = await createEmbeddedMemory(stores, query, { subjectId: null });
    const subjectBMemory = await createEmbeddedMemory(stores, query, { subjectId: "user-b" });

    const result = await runtime.recall(ctx, {
      vector: query,
      includeSubjectless: true,
      limit: 10,
    });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(subjectAMemory.id);
    expect(ids).toContain(subjectlessMemory.id);
    expect(ids).not.toContain(subjectBMemory.id);
  });

  it("includeSubjectless: 省略/false なら、主題なし（null）は今日どおり返らない（回帰）", async () => {
    const query = [1, 0];

    for (const includeSubjectless of [undefined, false] as const) {
      const { runtime, stores } = buildRuntime((fvs) => new SubjectFilterStrippingVectorStore(fvs));
      const subjectAMemory = await createEmbeddedMemory(stores, query, { subjectId: "user-a" });
      const subjectlessMemory = await createEmbeddedMemory(stores, query, { subjectId: null });

      const result = await runtime.recall(ctx, {
        vector: query,
        ...(includeSubjectless === undefined ? {} : { includeSubjectless }),
        limit: 10,
      });
      const ids = result.memories.map((m) => m.memoryId);

      expect(ids).toContain(subjectAMemory.id);
      expect(ids).not.toContain(subjectlessMemory.id);
    }
  });

  it("ctx.subjectId 無しで includeSubjectless: true を渡しても、テナント全体（絞りなし）と同じになる", async () => {
    const { runtime, stores } = buildRuntime((fvs) => new SubjectFilterStrippingVectorStore(fvs));
    const query = [1, 0];
    const tenantWideCtx: Ctx = { tenantId: "tenant-1" };

    const subjectAMemory = await createEmbeddedMemory(stores, query, { subjectId: "user-a" });
    const subjectlessMemory = await createEmbeddedMemory(stores, query, { subjectId: null });
    const subjectBMemory = await createEmbeddedMemory(stores, query, { subjectId: "user-b" });

    const tenantWide = await runtime.recall(tenantWideCtx, { vector: query, limit: 10 });
    const withIncludeSubjectlessButNoSubjectId = await runtime.recall(tenantWideCtx, {
      vector: query,
      includeSubjectless: true,
      limit: 10,
    });

    const tenantWideIds = tenantWide.memories.map((m) => m.memoryId).sort();
    const otherIds = withIncludeSubjectlessButNoSubjectId.memories.map((m) => m.memoryId).sort();
    expect(otherIds).toEqual(tenantWideIds);
    expect(tenantWideIds).toEqual(
      [subjectAMemory.id, subjectlessMemory.id, subjectBMemory.id].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 段3.5（連想枠）専用の後置フィルタの歯（`recall-association-gates.test.ts` の
// `AssociationGateStrippingVectorStore` と同型）。
//
// 🔴 **この describe が無いと、段1（`survivesSubjectFilter` の1つ目の呼び出し）だけを
// 検査する変異試験が、段3.5（2つ目の呼び出し）を1つも通さない。** 上の
// `SubjectFilterStrippingVectorStore` は**すべての** search() 呼び出しから subjectId/
// includeSubjectless を剥がすため、段1の post-filter が先に候補を絞り込んでしまい、
// 段3.5 側の post-filter が実際に「別の候補で」試されることが無い——`recall-association-
// gates.test.ts` 冒頭のコメントが説明する「1本目で先に落ちると、2本目の後置は露出しない」
// のと同じ理由。ここでは**2本目以降（連想用）の search() だけ**から剥がす。
// ---------------------------------------------------------------------------

/** Q=[1,0] に対して類似度 0.7071——段1で拾われ、連想のアンカーになる。 */
const ANCHOR_VECTOR = [0.70710678, 0.70710678];
/**
 * Q=[1,0] との類似度は 0 ちょうど（段1では below_threshold）だが、アンカーとの類似度は
 * 0.7071（既定 minSimilarity 0.5 以上）——**連想枠でしか返ってこない**位置。
 */
const ASSOCIATED_VECTOR = [0, 1];

class AssociationSubjectFilterStrippingVectorStore implements VectorStore {
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
    // 🔑 2本目以降（連想用）だけ subjectId/includeSubjectless を剥がす。段1はそのまま。
    const {
      subjectId: _subjectId,
      includeSubjectless: _includeSubjectless,
      ...stripped
    } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 連想枠（段3.5）専用の後置フィルタが includeSubjectless を正しく適用する", () => {
  it("連想用 search() が subjectId/includeSubjectless を無視しても、段3.5 の後置フィルタが正しく絞る", async () => {
    const { runtime, stores } = buildRuntime(
      (fvs) => new AssociationSubjectFilterStrippingVectorStore(fvs),
    );

    const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, {
      subjectId: "user-a",
      digest: "アンカー本文",
    });
    const subjectlessAssociated = await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, {
      subjectId: null,
      digest: "連想・主題なし",
    });
    const subjectBAssociated = await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, {
      subjectId: "user-b",
      digest: "連想・別subject",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      includeSubjectless: true,
      association: { maxCount: 5, anchorCount: 1 },
    });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(anchor.id);
    expect(ids).toContain(subjectlessAssociated.id);
    expect(ids).not.toContain(subjectBAssociated.id);
  });

  it("includeSubjectless: 省略/false なら、連想枠でも主題なし（null）は返らない（回帰）", async () => {
    const { runtime, stores } = buildRuntime(
      (fvs) => new AssociationSubjectFilterStrippingVectorStore(fvs),
    );

    const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, {
      subjectId: "user-a",
      digest: "アンカー本文",
    });
    const subjectlessAssociated = await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, {
      subjectId: null,
      digest: "連想・主題なし",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: { maxCount: 5, anchorCount: 1 },
    });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(anchor.id);
    expect(ids).not.toContain(subjectlessAssociated.id);
  });
});
