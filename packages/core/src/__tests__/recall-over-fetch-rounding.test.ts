import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない: 他の `recall-*.test.ts` と同型の足場を独立に持つ。 */

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

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
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
    relationStore: stores.relationStore,
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

/** 段1の `vectorStore.search` に渡った `limit` を記録する。 */
function captureSearchLimits(stores: ReturnType<typeof createFakeRuntimeStores>): number[] {
  const limits: number[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (c, space, query, opts) => {
    limits.push(opts.limit);
    return originalSearch(c, space, query, opts);
  };
  return limits;
}

describe("recall() — overFetchFactor の丸め（k' = max(1, round(limit × overFetchFactor))）", () => {
  it.each([
    { limit: 3, overFetchFactor: 1.5, expected: 5 }, // 4.5 は切り上げ
    { limit: 5, overFetchFactor: 1.3, expected: 7 }, // 6.5 は切り上げ
    { limit: 3, overFetchFactor: 1.4, expected: 4 }, // 4.2 は切り捨て（常に切り上げではない）
  ])(
    "limit: $limit, overFetchFactor: $overFetchFactor なら、段1の検索は $expected 件で呼ばれ、trace の kPrime も同じ",
    async ({ limit, overFetchFactor, expected }) => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0]);
      const limits = captureSearchLimits(stores);

      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit,
        overFetchFactor,
        association: null,
      });

      expect(limits).toEqual([expected]);
      const candidateTrace = result.explain.stages.find((s) => s.stage === "candidate_generation");
      expect(candidateTrace?.detail).toMatchObject({ channel: "ann", kPrime: expected });
    },
  );
});
