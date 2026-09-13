import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

/**
 * ⭐ 配線の歯: `recall()` が `RecallQuery.excludeProvenanceKinds` を段1
 * （`VectorStore.search`）の filter に載せていることを検査する（ADR 0056）。
 *
 * `recall-subject-filter.test.ts`（ADR 0023 の配線の歯）と同型——`packages/core` 自身の
 * テストなので `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと
 * 同じ理由）。DB を要さないため手元で実行できる。
 *
 * ⟹ `recall-runtime.ts` の段1呼び出しから `excludeProvenanceKinds:` の行を消す変異を
 * 当てると、1つ目の it() が確実に赤くなる
 * （`capturedFilters[0]?.excludeProvenanceKinds` が `undefined` になる）。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");

/**
 * `vectorStoreOverride` を渡さなければ従来どおり `stores.vectorStore`（FakeVectorStore 本体）を
 * runtime に注入する。渡すと、その結果を注入する——下の「段2専用の歯」が
 * `ExcludeProvenanceStrippingVectorStore` を挟むために使う（`recall-period-filter.test.ts` の
 * `PeriodStrippingVectorStore` と同型）。`stores` に載っている実体（`FakeBackingStore` 経由の
 * memory / vector）は override の有無に関わらず同じものを指す——`createEmbeddedMemory` は
 * いつも `stores.vectorStore.upsert` を直接呼ぶ。
 */
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
    // `RecallQuerySchema.excludeProvenanceKinds` は `.default()` を持たない zod スキーマ
    // （既定は `undefined`）——`?? []` で正規化して渡すこともこの契約上は許されるため、
    // どちらであっても段1が no-op になることだけを固定する（VectorFilter の doc 参照:
    // `undefined` と `[]` はどちらも no-op）。
    expect(passed === undefined || passed?.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⭐⭐ 段2（recall-runtime.ts の後段 excludeProvenanceKinds 再検査、
// `if (excludeKinds.has(memory.provenance.kind)) continue;`）専用の歯。
// ADR 0056 が変異試験の表に「生き残る」と記録した2件（変異5・変異6）のうち、
// 変異5（段2の除外集合を常に空にする）を塞ぐ。
//
// **上の describe を含め、通常の歯は必ず段1（FakeVectorStore）と段2
// （recall-runtime.ts）の両方を経由する。** 段1が `VectorFilter.excludeProvenanceKinds`
// を正しく適用している限り、段2の1行はコードとしては実行されても「落とす」役には
// 立たない（段1が既に落としているため）——ADR 0056 が「段1と段2が互いを庇っている」
// と書いた理由そのもの。
//
// ここでは `FakeVectorStore` を薄く包み、`search()` に渡ってきた `opts.filter` から
// `excludeProvenanceKinds` **だけ**を剥がしてから委譲する
// （`ExcludeProvenanceStrippingVectorStore`。`recall-period-filter.test.ts` の
// `PeriodStrippingVectorStore` と同型）。ADR 0056 が「段1がわざと絞らない adapter を
// 使って段2だけを検査する歯が要る」と書き残していた処方をそのまま実装したもの
// ——「`VectorFilter` の契約（ADR 0034）を守らない adapter」を歯の中だけで再現し、
// 段2だけが excludeProvenanceKinds を落とす状況を作る。他のフィールド（tenantId/
// status/subjectId/period/decayFloorAtAfter）はそのまま通す——
// excludeProvenanceKinds 以外まで段1でザルにすると、この歯が
// 「excludeProvenanceKinds だけを測っている」ことが言えなくなる。
//
// ⛔ 本番コード（recall-runtime.ts / vector-store.ts）は1文字も変えない——
// ラッパはこの test ファイルの中に閉じている。
// ---------------------------------------------------------------------------

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

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    // 🔑 excludeProvenanceKinds「だけ」を剥がす。他は素通し。
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

    // 除外対象（kind: "inferred"）。段1は excludeProvenanceKinds を見ないので、
    // 段2の `if (excludeKinds.has(memory.provenance.kind)) continue;` だけが落とせる。
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
    // 除外対象外（kind: "imported"、newMemory の既定）。2件（複数にしておくと、
    // たまたま1件だけ残る実装でも見分けが付く）。
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
    // 順序に依存しない（distance の僅差でタイブレークしうるため toContain/not.toContain で見る。
    // ADR 0040: ゼロベクトルは距離が NaN になるため、ここでは使わない）。limit=10 は
    // 候補4件に対して十分な余裕を持たせてあり、ぎりぎりにしていない。
    expect(digests).toContain("kept-imported-1");
    expect(digests).toContain("kept-imported-2");
    expect(digests).not.toContain("excluded-inferred-1");
    expect(digests).not.toContain("excluded-inferred-2");
  });
});
