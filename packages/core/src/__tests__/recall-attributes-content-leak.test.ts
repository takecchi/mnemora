import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { AggregateScopeOptions, MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { RecallScope } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * レビュー指摘（マネージャー経由、2026-09-25）: `attributes` による絞り込み（Issue #152/#153、
 * ADR 0312）は、段1（ANN・語彙の候補生成）と段3.5（連想枠）の後置フィルタ
 * （`survivesAttributesFilter`）でしか検査していなかった。**Memory の中身（`digest`）が
 * `RecallResult` に乗る経路は他に2つあり、どちらも検査を素通りしていた**:
 *
 * 1. **段3（必須の同伴取得、mandatory companion retrieval）**——`contested` の相手を
 *    `MemoryStore.getMany` で直接取りに行くだけで、後置フィルタを一度も経由しない。
 * 2. **段5（目次帯、digest band）**——`MemoryStore.aggregateScope` の `digests` を
 *    そのまま `packDigestBand` に渡すだけで、`scope.attributes` を無視する自作
 *    `MemoryStore` だと絞り込みの外の `digest` がそのまま紛れ込む。
 *
 * このファイルは、その2つの穴を**赤→緑**で固定する。`packages/core` 自身のテストなので
 * `@mnemora/testkit` には依存しない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

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

function buildRuntime(memoryStoreOverride?: (fms: MemoryStore) => MemoryStore) {
  const stores = createFakeRuntimeStores();
  const memoryStore = memoryStoreOverride
    ? memoryStoreOverride(stores.memoryStore)
    : stores.memoryStore;
  const runtime = createRuntime({
    memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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

// ---------------------------------------------------------------------------
// 1. 必須の同伴取得（段3）: 対向の attributes が絞り込みに一致しなければ、
//    ペアごと落ちる（争われている主張を、争われていない顔で単独で出さない、という
//    既存原則と同じ落ち方——unit_assembly_dropped、ADR 0043）。
// ---------------------------------------------------------------------------

describe("recall() — 必須の同伴取得（段3）にも attributes が掛かる（レビュー指摘、ADR 0312 追記）", () => {
  it("対向（companion）の attributes が絞り込みに一致しなければ、争っている側ごと結果から落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    const strong = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "強い方",
        embeddingStatus: "ready",
        attributes: { visibility: "internal" },
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, strong.id, [1, 0]);
    // わざとクエリベクトルから離す——スコアだけなら選ばれない側（`mark-contested.test.ts`
    // 「recall() の段3が実際に発火する」歯と同じ道具立て）。
    const weak = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "弱い方",
        embeddingStatus: "ready",
        attributes: { visibility: "public" },
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, weak.id, [0, 1]);

    const markResult = await runtime.markContested(ctx, strong.id, weak.id);
    expect(markResult.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      attributes: { visibility: "internal" },
    });

    const ids = result.memories.map((m) => m.memoryId);
    // 🔴 本命: `weak`（visibility: public）の digest が、絞り込みの外から紛れ込んでは
    // ならない。
    expect(ids).not.toContain(weak.id);
    // ⭐ 争われている主張を、争われていない顔で単独で出すくらいなら、両方とも出さない
    // （docs/recall.md §8 と同じ判断——同伴が絞り込みで落ちたら、本体も一緒に落ちる）。
    expect(ids).not.toContain(strong.id);

    // 段3自体は発火した（同伴を取りに行った）が、attributes で落ちたので companions
    // には積まれない。
    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.detail).toEqual({ companionsAdded: 0 });

    // 落ちたことが黙って消えない——既存の unit_assembly_dropped（ADR 0043）に乗る。
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it("対照: 対向の attributes が一致すれば、今日どおり両方とも返る（歯が「常に落とす」で通っていないことの検算）", async () => {
    const { runtime, stores } = buildRuntime();
    const strong = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "強い方",
        embeddingStatus: "ready",
        attributes: { visibility: "internal" },
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, strong.id, [1, 0]);
    const weak = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "弱い方",
        embeddingStatus: "ready",
        attributes: { visibility: "internal" },
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, weak.id, [0, 1]);

    await runtime.markContested(ctx, strong.id, weak.id);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      attributes: { visibility: "internal" },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(strong.id);
    expect(ids).toContain(weak.id);
    const companion = result.memories.find((m) => m.memoryId === weak.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
  });
});

// ---------------------------------------------------------------------------
// 2. 目次帯（段5）: `scope.attributes` を無視する自作 MemoryStore でも、
//    絞り込みの外の digest が紛れ込まない。
// ---------------------------------------------------------------------------

/**
 * `attributes を無視する自作 MemoryStore`。`aggregateScope` の `scope.attributes` を
 * 呼ぶ前に剥がしてから委譲する——「filter を実際に検査できる fake」と「検査できない
 * （＝知らない）fake」の違いを、他のフィールド（tenantId/subjectId 等）は一切変えずに
 * 再現する（`recall-attributes-filter.test.ts` の
 * `AttributesFilterStrippingVectorStore` と同型）。
 */
function withAttributesIgnoringAggregateScope(inner: MemoryStore): MemoryStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "aggregateScope") {
        return async (c: Ctx, scope: RecallScope, opts?: AggregateScopeOptions) => {
          const { attributes: _ignored, ...strippedScope } = scope;
          return target.aggregateScope(c, strippedScope, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryStore;
}

describe("recall() — 目次帯（段5）にも attributes が掛かる（レビュー指摘、ADR 0312 追記）", () => {
  it("scope.attributes を無視する MemoryStore.aggregateScope でも、digestBand に絞り込みの外の digest は乗らない", async () => {
    const { runtime, stores } = buildRuntime((fms) => withAttributesIgnoringAggregateScope(fms));
    // 目次帯にしか現れないよう、どちらもベクトルを登録しない（段1の候補にはならない）。
    const matching = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "internal 本文の要旨", attributes: { visibility: "internal" } }),
    );
    const mismatching = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "public 本文の要旨", attributes: { visibility: "public" } }),
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      attributes: { visibility: "internal" },
      digestBandLimit: 10,
    });

    const bandIds = (result.index.digestBand ?? []).map((d) => d.memoryId);
    // 🔴 本命: 絞り込みの外（`mismatching`）の digest が紛れ込んではならない。
    expect(bandIds).not.toContain(mismatching.id);
    expect(bandIds).toContain(matching.id);
  });

  it("対照: attributes を渡さない recall では、（この非対応 MemoryStore でも）今日どおり両方が目次帯に乗る", async () => {
    const { runtime, stores } = buildRuntime((fms) => withAttributesIgnoringAggregateScope(fms));
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "A 本文の要旨", attributes: { visibility: "internal" } }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "B 本文の要旨", attributes: { visibility: "public" } }),
    );

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, digestBandLimit: 10 });

    const bandIds = (result.index.digestBand ?? []).map((d) => d.memoryId);
    expect(bandIds).toContain(a.id);
    expect(bandIds).toContain(b.id);
  });

  it("attributes で落ちた分だけ digestEligible.count を減らし、countKind を 'unknown' にする（真の資格件数を僭称しない）", async () => {
    const { runtime, stores } = buildRuntime((fms) => withAttributesIgnoringAggregateScope(fms));
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "internal", attributes: { visibility: "internal" } }),
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "public", attributes: { visibility: "public" } }),
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      attributes: { visibility: "internal" },
      digestBandLimit: 10,
    });

    expect(result.index.digestBandCoverage?.eligible).toBe(1);
    expect(result.index.digestBandCoverage?.countKind).toBe("unknown");
  });
});
