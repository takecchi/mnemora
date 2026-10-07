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

/** `vectorStoreOverride` を渡すと、その結果を runtime に注入する（段2専用の歯が `PeriodStrippingVectorStore` を挟むために使う）。 */
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

describe("recall() — 段1の filter に occurredAfter/occurredBefore が載ること（配線の歯、ADR 0059）", () => {
  it("occurredAfter/occurredBefore を渡すと VectorStore.search の opts.filter に渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const occurredAfter = new Date("2026-01-01T00:00:00.000Z");
    const occurredBefore = new Date("2026-05-01T00:00:00.000Z");
    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0], occurredAfter, occurredBefore });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.occurredAfter).toEqual(occurredAfter);
    expect(capturedFilters[0]?.occurredBefore).toEqual(occurredBefore);
  });

  it("occurredAfter/occurredBefore を渡さないときは段1の filter も undefined のまま渡る（期間を絞らない既定動作を壊さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.occurredAfter).toBeUndefined();
    expect(capturedFilters[0]?.occurredBefore).toBeUndefined();
  });
});

const ctx: Ctx = { tenantId: "tenant-1" };

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
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — period の押し下げが over-fetch の窓（k'）を無駄にしない（ADR 0059、実際に何を変えるかを測る歯）", () => {
  it("期間外の候補（distance 0）が窓を埋めても、期間内の候補（distance > 0）が返る", async () => {
    const { runtime, stores } = buildRuntime();

    const occurredAfter = new Date("2026-01-01T00:00:00.000Z");
    const query = [1, 0];

    // crowd: 期間外・距離 0。limit=3, overFetchFactor=1 で k'=3 なので、押し下げが無いと窓が crowd だけで埋まる。
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, query, {
        occurredAt: new Date("2020-01-01T00:00:00.000Z"),
      });
    }

    const targetIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const memory = await createEmbeddedMemory(stores, [1, 0.01], {
        occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      });
      targetIds.push(memory.id);
    }

    const result = await runtime.recall(ctx, {
      vector: query,
      occurredAfter,
      limit: 3,
      overFetchFactor: 1,
    });

    expect(result.memories).toHaveLength(3);
    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([...targetIds].sort());
  });
});

// 段2専用の歯。通常の歯は段1と段2の両方を経由し、段1が period を適用している限り段2は「落とす」役に立たない。
// `FakeVectorStore` を包み、`search()` の filter から `occurredAfter`/`occurredBefore` だけを剥がして段2だけを検査する。
// 他のフィールドはそのまま通す（period 以外まで段1でザルにすると、period だけを測っているとは言えなくなる）。

class PeriodStrippingVectorStore implements VectorStore {
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
    const {
      occurredAfter: _occurredAfter,
      occurredBefore: _occurredBefore,
      ...periodStripped
    } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: periodStripped });
  }
}

describe("recall() — 段2（recall-runtime.ts の後段 period 再検査）専用の歯（ADR 0059、生き残り2件目）", () => {
  it("段1が period を見ない adapter でも、段2の再検査だけで期間外の候補が落ちる", async () => {
    const { runtime, stores } = buildRuntime((fvs) => new PeriodStrippingVectorStore(fvs));

    const occurredAfter = new Date("2026-01-01T00:00:00.000Z");
    const occurredBefore = new Date("2026-05-01T00:00:00.000Z");
    const query = [1, 0];

    await createEmbeddedMemory(stores, [1, 0], {
      digest: "old-outside-period",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    await createEmbeddedMemory(stores, [1, 0.02], {
      digest: "future-outside-period",
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
    });
    // 期間内は2件にする: たまたま1件だけ残る実装でも見分けが付く。
    await createEmbeddedMemory(stores, [1, 0.01], {
      digest: "recent-inside-period-1",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    await createEmbeddedMemory(stores, [1, 0.015], {
      digest: "recent-inside-period-2",
      occurredAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    const result = await runtime.recall(ctx, {
      vector: query,
      occurredAfter,
      occurredBefore,
      limit: 10,
      overFetchFactor: 4,
    });

    const digests = result.memories.map((m) => m.digest);
    // 順序に依存しない: distance の僅差でタイブレークしうるため toContain で見る。ゼロベクトルは距離が NaN になるので使わない（ADR 0040）。
    expect(digests).toContain("recent-inside-period-1");
    expect(digests).toContain("recent-inside-period-2");
    expect(digests).not.toContain("old-outside-period");
    expect(digests).not.toContain("future-outside-period");
  });
});
