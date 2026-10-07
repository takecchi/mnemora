import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。 */

const NOW = new Date("2026-06-01T00:00:00.000Z");

/** `vectorStoreOverride` を渡すと、その結果を runtime に注入する（段2専用の歯が `ExcludeProvenanceStrippingVectorStore` を挟むために使う）。 */
function buildRuntime(vectorStoreOverride?: (fvs: FakeVectorStore) => VectorStore) {
  const stores = createFakeRuntimeStores();
  const vectorStore = vectorStoreOverride
    ? vectorStoreOverride(stores.vectorStore)
    : stores.vectorStore;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
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

describe("recall() — 段1の filter に excludeProvenanceKinds が載ること（配線の歯、ADR 0056）", () => {
  it("excludeProvenanceKinds を渡すと VectorStore.search の opts.filter.excludeProvenanceKinds に渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0], excludeProvenanceKinds: ["inferred"] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.excludeProvenanceKinds).toEqual(["inferred"]);
  });

  it("excludeProvenanceKinds を渡さないときは段1の filter が no-op のまま渡る（undefined か空配列。ADR 0056の非対称）", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    const passed = capturedFilters[0]?.excludeProvenanceKinds;
    // `.default()` を持たないので `?? []` で渡すことも契約上許される。どちらでも段1が no-op になることだけを固定する。
    expect(passed === undefined || passed?.length === 0).toBe(true);
  });
});

// 段2専用の歯。通常の歯は段1と段2の両方を経由し、段1が除外を適用している限り段2の除外は「落とす」役に立たない（互いを庇う）。
// `FakeVectorStore` を包み、`search()` の filter から `excludeProvenanceKinds` だけを剥がして段2だけを検査する。
// 他のフィールドはそのまま通す（それ以外まで段1でザルにすると、excludeProvenanceKinds だけを測っているとは言えなくなる）。

class ExcludeProvenanceStrippingVectorStore implements VectorStore {
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
    const { excludeProvenanceKinds: _excludeProvenanceKinds, ...provenanceStripped } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: provenanceStripped });
  }
}

const stage2Ctx: Ctx = { tenantId: "tenant-1" };

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

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    stage2Ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(stage2Ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — 段2（recall-runtime.ts の後段 excludeProvenanceKinds 再検査）専用の歯（ADR 0056、生き残り変異5）", () => {
  it("段1が excludeProvenanceKinds を見ない adapter でも、段2の再検査だけで除外対象の kind が落ちる", async () => {
    const { runtime, stores } = buildRuntime(
      (fvs) => new ExcludeProvenanceStrippingVectorStore(fvs),
    );

    const query = [1, 0];

    const inferredProvenance = {
      kind: "inferred" as const,
      model: "test-model",
      promptVersion: "v1",
      basis: { memoryIds: [], observationIds: [] },
      confidence: 0.9,
    };
    await createEmbeddedMemory(stores, [1, 0.01], {
      digest: "excluded-inferred-1",
      provenance: inferredProvenance,
    });
    await createEmbeddedMemory(stores, [1, 0.015], {
      digest: "excluded-inferred-2",
      provenance: inferredProvenance,
    });
    // 除外対象外は2件にする: たまたま1件だけ残る実装でも見分けが付く。
    await createEmbeddedMemory(stores, [1, 0.02], {
      digest: "kept-imported-1",
    });
    await createEmbeddedMemory(stores, [1, 0.025], {
      digest: "kept-imported-2",
    });

    const result = await runtime.recall(stage2Ctx, {
      vector: query,
      excludeProvenanceKinds: ["inferred"],
      limit: 10,
      overFetchFactor: 4,
    });

    const digests = result.memories.map((m) => m.digest);
    // 順序に依存しない: distance の僅差でタイブレークしうるため toContain で見る。ゼロベクトルは距離が NaN になるので使わない（ADR 0040）。
    expect(digests).toContain("kept-imported-1");
    expect(digests).toContain("kept-imported-2");
    expect(digests).not.toContain("excluded-inferred-1");
    expect(digests).not.toContain("excluded-inferred-2");
  });
});

// 段1専用の歯。素の `FakeVectorStore` を使い、crowd（除外対象 kind・distance 0）が over-fetch の窓を埋めても target が返ることを測る。
// 段2は生かしたまま: 段1が crowd を落とさないと窓が crowd で埋まり target が候補に現れない、という段1固有の主張だけを測るため。

describe("recall() — 段1（FakeVectorStore の excludeProvenanceKinds 適用）が over-fetch の窓（k'）を無駄にしない専用の歯（ADR 0056、変異6の族）", () => {
  it("除外対象の kind（distance 0）が窓を埋めても、除外対象外の kind（distance > 0）が返る", async () => {
    const { runtime, stores } = buildRuntime();

    const query = [1, 0];
    const inferredProvenance = {
      kind: "inferred" as const,
      model: "test-model",
      promptVersion: "v1",
      basis: { memoryIds: [], observationIds: [] },
      confidence: 0.9,
    };

    // limit=3, overFetchFactor=1 なので k'=3: 段1が除外しないと窓は crowd だけで埋まる。
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, query, {
        digest: `crowd-inferred-${i}`,
        provenance: inferredProvenance,
      });
    }

    const targetIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const memory = await createEmbeddedMemory(stores, [1, 0.01], {
        digest: `target-imported-${i}`,
      });
      targetIds.push(memory.id);
    }

    const result = await runtime.recall(stage2Ctx, {
      vector: query,
      excludeProvenanceKinds: ["inferred"],
      limit: 3,
      overFetchFactor: 1,
    });

    expect(result.memories).toHaveLength(3);
    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([...targetIds].sort());
  });
});
