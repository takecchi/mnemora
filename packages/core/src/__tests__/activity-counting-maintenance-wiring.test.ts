import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 保守の操作（`findCorrectionCandidates`・`consolidate`・`reflect`）は内部で `recall()` を1回呼ぶ。
 * その `recall()` へ、呼び手が渡した `activityCounting` が届くこと（`'subject'` なら、`ctx.subjectId` の
 * 活動カウンタ `S` だけが進み、テナントのカウンタ `T` は進まない。省略は `'tenant'` で、`T` が進む）。
 * 届かないと、前進するカウンタが黙って違う側になるだけで、返る記憶は変わらないので、
 * `recall()` を直接呼ぶ歯だけでは気づけない。
 *
 * `RecallQuery.activityCounting` の値は `'tenant'` と `'subject'` だけで、知らない値は断る。
 */

const TENANT = "tenant-maintenance-wiring";
const aliceCtx: Ctx = { tenantId: TENANT, subjectId: "alice" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
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

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: TENANT,
    subjectId: "alice",
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

async function build() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  await stores.tenantSettingsStore.setDecayClock(aliceCtx, "activity");
  const seed = await stores.memoryStore.createMemory(
    aliceCtx,
    newMemory({ content: "seed content", digest: "seed" }),
  );
  await stores.vectorStore.upsert(aliceCtx, stores.embeddingProvider.space, seed.id, [4, 0]);
  const near = await stores.memoryStore.createMemory(
    aliceCtx,
    newMemory({ content: "near content", digest: "nr" }),
  );
  await stores.vectorStore.upsert(aliceCtx, stores.embeddingProvider.space, near.id, [8, 0]);
  return { runtime, stores, seed };
}

async function counters(stores: ReturnType<typeof createFakeRuntimeStores>) {
  const tenant = await stores.tenantSettingsStore.getActivitySeq(aliceCtx);
  const subject = (await stores.tenantSettingsStore.getSubjectActivitySeqs!(aliceCtx, ["alice"]))[
    "alice"
  ];
  return { tenant, subject: subject ?? 0 };
}

type Runtime = Awaited<ReturnType<typeof build>>["runtime"];
type Seed = Awaited<ReturnType<typeof build>>["seed"];

const OPERATIONS: Array<
  [string, (runtime: Runtime, seed: Seed, counting?: "tenant" | "subject") => Promise<unknown>]
> = [
  [
    "findCorrectionCandidates",
    (runtime, _seed, counting) =>
      runtime.findCorrectionCandidates(aliceCtx, {
        text: "seed",
        ...(counting ? { activityCounting: counting } : {}),
      }),
  ],
  [
    "consolidate の { seedMemoryId } 形",
    (runtime, seed, counting) =>
      runtime.consolidate(aliceCtx, {
        target: {
          seedMemoryId: seed.id,
          ...(counting ? { activityCounting: counting } : {}),
        },
      }),
  ],
  [
    "reflect の { seedMemoryId } 形",
    (runtime, seed, counting) =>
      runtime.reflect(aliceCtx, {
        target: {
          seedMemoryId: seed.id,
          ...(counting ? { activityCounting: counting } : {}),
        },
      }),
  ],
  [
    "consolidate の { query } 形",
    (runtime, _seed, counting) =>
      runtime.consolidate(aliceCtx, {
        target: {
          query: { vector: [4, 0], ...(counting ? { activityCounting: counting } : {}) },
        },
      }),
  ],
  [
    "reflect の { query } 形",
    (runtime, _seed, counting) =>
      runtime.reflect(aliceCtx, {
        target: {
          query: { vector: [4, 0], ...(counting ? { activityCounting: counting } : {}) },
        },
      }),
  ],
];

describe("保守の操作の内部 recall へ activityCounting が届く", () => {
  it.each(OPERATIONS)("%s: 'subject' なら subject のカウンタだけが進む", async (_name, run) => {
    const { runtime, stores, seed } = await build();
    await run(runtime, seed, "subject");
    expect(await counters(stores)).toEqual({ tenant: 0, subject: 1 });
  });

  it.each(OPERATIONS)(
    "%s: 省略（'tenant'）ならテナントのカウンタだけが進む",
    async (_name, run) => {
      const { runtime, stores, seed } = await build();
      await run(runtime, seed);
      expect(await counters(stores)).toEqual({ tenant: 1, subject: 0 });
    },
  );
});

describe("RecallQuery.activityCounting の値の範囲", () => {
  it.each(["", "Subject", "tenant ", "global"])(
    "知らない値 %j は recall() が ZodError で断り、どのカウンタも進めない",
    async (value) => {
      const { runtime, stores } = await build();
      await expect(
        runtime.recall(aliceCtx, { vector: [4, 0], activityCounting: value as never }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(await counters(stores)).toEqual({ tenant: 0, subject: 0 });
    },
  );
});
