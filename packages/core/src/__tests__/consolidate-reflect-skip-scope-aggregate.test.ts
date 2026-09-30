import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { AggregateScopeOptions } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * consolidate / reflect が内部で呼ぶ `recall()` は、`memories` しか読まない
 * （`totalInScope`・目次帯・`filtered*` は読まない）。**それなのに `scopeAggregate` の既定 `"exact"` のまま
 * `MemoryStore.aggregateScope` を呼ぶと、100万行では `GROUP BY subject_id` の件数集計が毎回走る**
 * （ADR 0415）。この歯は、consolidate / reflect の各形（`{ seedMemoryId }`・`{ query }`）と、
 * tick の consolidate / reflect ジョブが、`aggregateScope` を `"skip"` で呼ぶことを縛る。
 *
 * 逆側の歯（読む側は変えない）: `findCorrectionCandidates` は `omitted`・`explain` を利用者へ返すので
 * `"exact"` のまま、`runtime.recall()` の直接呼び出しも `"exact"` のままである。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
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
    ...overrides,
  };
}

/** 統合・内省のどちらの schema にも通る決定的な偽物（recall の後の LLM 呼び出しは、ここでは関心の外）。 */
const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
    const extracted = req.schema.safeParse({
      memories: [{ content: "本文", digest: "要旨", provenanceKind: "stated" }],
    });
    if (extracted.success) return extracted.data as T;
    const reflected = req.schema.safeParse({
      outcome: "reflected",
      content: "内省",
      digest: "内省",
    });
    return (
      reflected.success ? reflected.data : req.schema.parse({ content: "統合", digest: "統合" })
    ) as T;
  },
};

async function build(config?: { autoQueueConsolidateReflectOnExtract?: boolean }) {
  const stores = createFakeRuntimeStores();
  const calls: Array<AggregateScopeOptions | undefined> = [];
  const memoryStore = new Proxy(stores.memoryStore, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "aggregateScope" && typeof value === "function") {
        return async (...args: unknown[]) => {
          calls.push(args[2] as AggregateScopeOptions | undefined);
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = createRuntime({
    memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    // tick の claim は outbox の runAfter（実時計で積まれる）と比べるので、時計は実時間より先に置く。
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
    ...(config !== undefined ? { config } : {}),
  });
  const seed = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ content: "seed content", digest: "seed" }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);
  const near = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ content: "near content", digest: "nr" }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, near.id, [8, 0]);
  return { runtime, stores, calls, seed };
}

describe("consolidate / reflect の内部 recall は aggregateScope を skip で呼ぶ（ADR 0415）", () => {
  it.each(["consolidate", "reflect"] as const)(
    "%s の { seedMemoryId } 形は scopeAggregate: 'skip' で呼ぶ",
    async (method) => {
      const { runtime, calls, seed } = await build();
      await runtime[method](ctx, { target: { seedMemoryId: seed.id } });
      expect(calls).toHaveLength(1);
      expect(calls.map((c) => c?.scopeAggregate)).toEqual(["skip"]);
    },
  );

  it.each(["consolidate", "reflect"] as const)(
    "%s の { query } 形は、利用者が scopeAggregate を渡さなければ 'skip' で呼ぶ",
    async (method) => {
      const { runtime, calls } = await build();
      await runtime[method](ctx, { target: { query: { vector: [4, 0] } } });
      expect(calls.map((c) => c?.scopeAggregate)).toEqual(["skip"]);
    },
  );

  it.each(["consolidate", "reflect"] as const)(
    "%s の { query } 形で利用者が scopeAggregate: 'exact' を明示したら尊重する",
    async (method) => {
      const { runtime, calls } = await build();
      await runtime[method](ctx, {
        target: { query: { vector: [4, 0], scopeAggregate: "exact" } },
      });
      expect(calls.map((c) => c?.scopeAggregate)).toEqual(["exact"]);
    },
  );

  it("tick の consolidate / reflect ジョブも skip で呼ぶ", async () => {
    const { runtime, calls } = await build({ autoQueueConsolidateReflectOnExtract: true });
    await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    calls.length = 0;
    const result = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(result.processed).toBeGreaterThanOrEqual(2);
    // consolidate と reflect の2ジョブ分の recall。どちらも skip。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.map((c) => c?.scopeAggregate)).toEqual(calls.map(() => "skip"));
  });

  it("読む側は変えない: 直接の recall() と findCorrectionCandidates は exact のまま", async () => {
    const { runtime, calls } = await build();
    await runtime.recall(ctx, { text: "seed" });
    await runtime.findCorrectionCandidates(ctx, { text: "seed" });
    expect(calls.map((c) => c?.scopeAggregate)).toEqual(["exact", "exact"]);
  });
});
