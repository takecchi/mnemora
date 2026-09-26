import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { InferredProvenance } from "../provenance.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #883（[ADR 0342](../../../docs/decisions/0342-recalled-memory-basis-lost.md)）:
 * `RecalledMemory.basisLost` — `provenanceKind === "inferred"` の記憶が、根拠
 * （`basis.memoryIds`）を失っている（存在しない/forgotten/purge済み）ときに立つ印。
 *
 * docs/memory-model.md §2 が約束していた「根拠を失った推論に印を付けて返す」の実装。
 * `recall-exclude-provenance-filter.test.ts` と同じ理由で `@mnemora/testkit` に依存しない
 * （`runtime-fakes.ts` 冒頭のコメント参照）。
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

function inferredProvenance(basisMemoryIds: string[]): InferredProvenance {
  return {
    kind: "inferred",
    model: "test-model",
    promptVersion: "v1",
    basis: { memoryIds: basisMemoryIds, observationIds: [] },
    confidence: 0.9,
  };
}

function buildRuntimeFromStores(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  memoryStoreOverride?: MemoryStore,
) {
  return createRuntime({
    memoryStore: memoryStoreOverride ?? stores.memoryStore,
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
}

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = buildRuntimeFromStores(stores);
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

describe("recall() — RecalledMemory.basisLost（Issue #883、ADR 0342）", () => {
  it("(a) basis の相手を forget した後、inferred の記憶には basisLost: true が付く", async () => {
    const { runtime, stores } = buildRuntime();
    const basis = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "basis-memory" }));
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      digest: "推論された記憶",
      provenance: inferredProvenance([basis.id]),
    });

    const forgetResult = await runtime.forget(ctx, { memoryId: basis.id });
    expect(forgetResult.outcomes[0]?.kind).toBe("forgotten");

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returned = result.memories.find((m) => m.memoryId === inferred.id);
    expect(returned).toBeDefined();
    expect(returned?.basisLost).toBe(true);
  });

  it("(b) basis の相手を forget してから purge した後も、inferred の記憶には basisLost: true が付く", async () => {
    const { runtime, stores } = buildRuntime();
    const basis = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "basis-memory-to-purge" }),
    );
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      digest: "推論された記憶2",
      provenance: inferredProvenance([basis.id]),
    });

    const forgetResult = await runtime.forget(ctx, { memoryId: basis.id });
    expect(forgetResult.outcomes[0]?.kind).toBe("forgotten");
    const purgeResult = await runtime.purge(ctx, { memoryId: basis.id });
    expect(purgeResult.outcomes[0]?.kind).toBe("purged");

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returned = result.memories.find((m) => m.memoryId === inferred.id);
    expect(returned).toBeDefined();
    expect(returned?.basisLost).toBe(true);
  });

  it("(c) basis が生きている（active）限り、basisLost キー自体が無い", async () => {
    const { runtime, stores } = buildRuntime();
    const basis = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "basis-alive" }));
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      digest: "推論された記憶3",
      provenance: inferredProvenance([basis.id]),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returned = result.memories.find((m) => m.memoryId === inferred.id);
    expect(returned).toBeDefined();
    expect("basisLost" in returned!).toBe(false);
  });

  it("(c続き) basis が archived / superseded でも、本文は残っているので basisLost キー自体が無い", async () => {
    const { runtime, stores } = buildRuntime();
    const archivedBasis = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "basis-archived", status: "archived" }),
    );
    const supersededBasis = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "basis-superseded", status: "superseded" }),
    );
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      digest: "推論された記憶4",
      provenance: inferredProvenance([archivedBasis.id, supersededBasis.id]),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returned = result.memories.find((m) => m.memoryId === inferred.id);
    expect(returned).toBeDefined();
    expect("basisLost" in returned!).toBe(false);
  });

  it("(c続き) stated の記憶には basisLost が付かない（そもそも basis を持たない kind）", async () => {
    const { runtime, stores } = buildRuntime();
    const stated = await createEmbeddedMemory(stores, [1, 0], {
      digest: "本人が言った事実",
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returned = result.memories.find((m) => m.memoryId === stated.id);
    expect(returned).toBeDefined();
    expect("basisLost" in returned!).toBe(false);
  });

  it("存在しない memoryId を basis に持つ inferred にも basisLost: true が付く（getMany が静かに落とす契約）", async () => {
    const { runtime, stores } = buildRuntime();
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      digest: "根拠が最初から存在しない",
      provenance: inferredProvenance(["does-not-exist"]),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returned = result.memories.find((m) => m.memoryId === inferred.id);
    expect(returned).toBeDefined();
    expect(returned?.basisLost).toBe(true);
  });

  it("🔴 status が active のまま purgedAt だけが（不整合に）設定されている basis にも basisLost: true が付く（purgedAt 判定そのものの歯）", async () => {
    // 公開経路（`runtime.purge`）は forgotten からしか purge できない（docs/memory-model.md
    // §11 行10）ので、この組み合わせ（status='active' かつ purgedAt が非null）は
    // `runtime.forget`→`runtime.purge` を素直に呼ぶだけでは作れない。
    // `contested-pair-invariant` 系の既存の歯（`recall-pipeline.test.ts`）が
    // `MemoryStore` を直接叩いて不整合な状態を作るのと同じ手法——`FakeMemoryStore.createMemory`
    // は `input.purgedAt` をそのまま受け取って書き込む（`runtime-fakes.ts` 参照）ので、
    // ここでも直接その状態を作り、forgotten 判定を経由せずに purgedAt 判定だけを噛ませる。
    const { runtime, stores } = buildRuntime();
    const basis = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "active なのに purgedAt が残っている", purgedAt: NOW }),
    );
    const inferred = await createEmbeddedMemory(stores, [1, 0], {
      digest: "根拠が不整合な purgedAt を持つ",
      provenance: inferredProvenance([basis.id]),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });
    const returned = result.memories.find((m) => m.memoryId === inferred.id);
    expect(returned).toBeDefined();
    expect(returned?.basisLost).toBe(true);
  });
});

/**
 * (d) 往復数の歯: `MemoryStore.getMany` の呼び出し回数を数える。基準（inferred 無し）を
 * `getManyCallCount` の基準値とし、inferred が1件（basis 1件）でも複数件（basis 多数）でも
 * 「+1」のまま増えないことを確認する（PR 本文・Issue #883 の決定4「集めた id を1回だけ
 * `getMany` する」の実測）。
 *
 * `association: null`・contested companion 無し・`scope.attributes` 無し、という条件を
 * 揃えて、他の経路が呼ぶ `getMany`（段1候補フェッチ以外に、連想枠・同伴取得・属性再検査が
 * それぞれ独立に `getMany` を呼びうる）を混ぜないようにする——`recall-runtime.ts` の
 * `getMany` 呼び出し箇所は grep で4箇所確認済み（候補フェッチ・連想枠・同伴取得・
 * 目次帯の属性再検査）。
 */
function countingMemoryStore(store: MemoryStore): {
  wrapped: MemoryStore;
  getManyCallCount: () => number;
} {
  let count = 0;
  const wrapped: MemoryStore = new Proxy(store, {
    get(target, prop, _receiver) {
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
      if (prop === "getMany" && typeof value === "function") {
        return async (...args: unknown[]) => {
          count += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as MemoryStore;
  return { wrapped, getManyCallCount: () => count };
}

describe("recall() — RecalledMemory.basisLost の往復数（Issue #883、ADR 0342 決定4）", () => {
  it("inferred が無ければ getMany は候補フェッチの1回のみ、1件の basis でも多数の basis でも+1回のまま増えない", async () => {
    // 基準: inferred を含まない recall。
    const baselineStores = createFakeRuntimeStores();
    const { wrapped: baselineStore, getManyCallCount: baselineCount } = countingMemoryStore(
      baselineStores.memoryStore,
    );
    const baselineRuntime = buildRuntimeFromStores(baselineStores, baselineStore);
    await createEmbeddedMemory(baselineStores, [1, 0], { digest: "plain-1" });
    await createEmbeddedMemory(baselineStores, [0.99, 0.01], { digest: "plain-2" });
    await baselineRuntime.recall(ctx, { vector: [1, 0], association: null });
    const baselineCalls = baselineCount();
    expect(baselineCalls).toBe(1);

    // 1件の inferred、basis 1件。
    const oneBasisStores = createFakeRuntimeStores();
    const { wrapped: oneBasisStore, getManyCallCount: oneBasisCount } = countingMemoryStore(
      oneBasisStores.memoryStore,
    );
    const oneBasisRuntime = buildRuntimeFromStores(oneBasisStores, oneBasisStore);
    await createEmbeddedMemory(oneBasisStores, [1, 0], { digest: "plain-1" });
    const basis = await oneBasisStores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "basis" }),
    );
    await createEmbeddedMemory(oneBasisStores, [0.99, 0.01], {
      digest: "inferred-with-1-basis",
      provenance: inferredProvenance([basis.id]),
    });
    await oneBasisRuntime.recall(ctx, { vector: [1, 0], association: null });
    expect(oneBasisCount()).toBe(baselineCalls + 1);

    // 5件の inferred、それぞれ basis 5件（合計25件のユニークな basis memoryId）。
    const manyBasisStores = createFakeRuntimeStores();
    const { wrapped: manyBasisStore, getManyCallCount: manyBasisCount } = countingMemoryStore(
      manyBasisStores.memoryStore,
    );
    const manyBasisRuntime = buildRuntimeFromStores(manyBasisStores, manyBasisStore);
    await createEmbeddedMemory(manyBasisStores, [1, 0], { digest: "plain-1" });
    for (let i = 0; i < 5; i += 1) {
      const basisIds: string[] = [];
      for (let j = 0; j < 5; j += 1) {
        const b = await manyBasisStores.memoryStore.createMemory(
          ctx,
          newMemory({ digest: `basis-${i}-${j}` }),
        );
        basisIds.push(b.id);
      }
      await createEmbeddedMemory(manyBasisStores, [0.98 - i * 0.001, 0.02 + i * 0.001], {
        digest: `inferred-${i}`,
        provenance: inferredProvenance(basisIds),
      });
    }
    await manyBasisRuntime.recall(ctx, { vector: [1, 0], association: null });
    expect(manyBasisCount()).toBe(baselineCalls + 1);
  });
});
