import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { assertAffinityMeasured, createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

/**
 * 段2（再スコア）の並びは、`score.total` が同点のとき adapter の返す順に依存しない（`compareScoredCandidates` の TSDoc、ADR 0170）。
 * Fake の `search` は同点を `recordedAt` 降順→id 昇順で返し、段2のタイブレークとほぼ同じ順になるため、そのままでは段2が
 * タイブレークをしなくても結果が変わらない。そこで adapter の返す順を正順・逆順の両方で与え、どちらでも同じ並びになることを見る。
 *
 * 実効時刻だけを違えて `total` を揃えるには、`occurredAt` を未来に置く: `freshness` は 1 で頭打ちになり（ADR 0036）、
 * `decay` は `recordedAt` だけで決まるので、固定時計の `NOW` のもとでも `total` は同点のまま実効時刻だけが違う。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR_MS = 3_600_000;

function withReversedSearchOrder(store: FakeVectorStore): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => store.upsert(ctx, space, memoryId, vector),
    search: async (ctx, space, query, opts) =>
      [...(await store.search(ctx, space, query, opts))].reverse(),
    delete: (ctx, space, memoryId) => store.delete(ctx, space, memoryId),
    deleteAcrossSpaces: (ctx, memoryIds) => store.deleteAcrossSpaces(ctx, memoryIds),
    getVectors: (ctx, space, memoryIds) => store.getVectors(ctx, space, memoryIds),
  };
}

async function recallTied(
  tenantId: string,
  occurredAts: readonly (Date | null)[],
  adapterOrder: "as_is" | "reversed",
) {
  const ctx: Ctx = { tenantId };
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    vectorStore:
      adapterOrder === "reversed"
        ? withReversedSearchOrder(stores.vectorStore)
        : stores.vectorStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const strength = 1;
  const halfLifeHours = 24 * 365;
  const occurredAtById = new Map<string, Date | null>();
  for (const [i, occurredAt] of occurredAts.entries()) {
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文${i}`,
      contentHash: `hash-${i}`,
      digest: "d",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt,
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: NOW,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
      embeddingStatus: "ready",
    });
    occurredAtById.set(memory.id, occurredAt);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
  }
  const result = await runtime.recall(ctx, { vector: [1, 0], limit: 50, association: null });
  const totals = result.memories.map((r) => {
    assertAffinityMeasured(r.score);
    return r.score.total;
  });
  return { ids: result.memories.map((r) => r.memoryId), totals, occurredAtById };
}

describe("recall(): 段2で total が同点の記憶は、adapter が返す順によらず実効時刻の新しい順→id の昇順で返る", () => {
  it.each(["as_is", "reversed"] as const)(
    "total が同点で実効時刻（occurredAt）が違えば、新しいほうが先（adapter の順: %s）",
    async (adapterOrder) => {
      const { ids, totals, occurredAtById } = await recallTied(
        `recall-rescore-tie-order-time-${adapterOrder}`,
        [
          new Date(NOW.getTime() + 1 * HOUR_MS),
          new Date(NOW.getTime() + 2 * HOUR_MS),
          new Date(NOW.getTime() + 3 * HOUR_MS),
        ],
        adapterOrder,
      );
      expect(new Set(totals).size).toBe(1);
      const returnedOccurredAt = ids.map((id) => occurredAtById.get(id)!.getTime());
      expect(returnedOccurredAt).toEqual([...returnedOccurredAt].sort((a, b) => b - a));
      expect(ids).toHaveLength(3);
    },
  );

  it.each(["as_is", "reversed"] as const)(
    "total も実効時刻も同点なら、memory.id の昇順（adapter の順: %s）",
    async (adapterOrder) => {
      const { ids, totals } = await recallTied(
        `recall-rescore-tie-order-id-${adapterOrder}`,
        [null, null, null],
        adapterOrder,
      );
      expect(new Set(totals).size).toBe(1);
      expect(ids).toHaveLength(3);
      expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    },
  );
});
