import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100); // 壁時計では絶対に沈まない
const TENANT_ID = "tenant-338";
const tenantCtx: Ctx = { tenantId: TENANT_ID };
const aliceCtx: Ctx = { tenantId: TENANT_ID, subjectId: "alice" };
const bobCtx: Ctx = { tenantId: TENANT_ID, subjectId: "bob" };

// halfLifeRecalls=2、既定の閾値0.05（DEFAULT_DECAY_THRESHOLD）における床。
const HALF_LIFE_RECALLS = 2;
const DECAY_FLOOR_SEQ = 9;

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
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

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 100; // 壁時計では沈まない
  return {
    tenantId: TENANT_ID,
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
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({ recordedAt, lastReinforcedAt: null, strength, halfLifeHours }),
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
    tenantCtx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(tenantCtx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — activityCounting（ADR 0353、Issue #338）", () => {
  it("既定（'tenant'）: subject B に絞った recall を繰り返すと、subject A の記憶も沈む（回帰確認、本 ADR 以前と同じ挙動）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");

    await createEmbeddedMemory(stores, [1, 0], {
      digest: "alice-memory",
      subjectId: "alice",
      decayBaseSeq: 0,
      decayFloorSeq: DECAY_FLOOR_SEQ,
      halfLifeRecalls: HALF_LIFE_RECALLS,
      decayFloorAt: FAR_FUTURE,
    });
    await createEmbeddedMemory(stores, [0, 1], {
      digest: "bob-memory",
      subjectId: "bob",
      decayBaseSeq: 0,
      decayFloorSeq: DECAY_FLOOR_SEQ,
      halfLifeRecalls: HALF_LIFE_RECALLS,
      decayFloorAt: FAR_FUTURE,
    });

    for (let i = 0; i < DECAY_FLOOR_SEQ + 2; i += 1) {
      await runtime.recall(bobCtx, { vector: [0, 1], scoreThreshold: 0 });
    }

    const aliceResult = await runtime.recall(aliceCtx, { vector: [1, 0], scoreThreshold: 0 });
    expect(aliceResult.memories.map((m) => m.memoryId)).toEqual([]);
  });

  it("'subject': subject B に絞った recall を繰り返しても、subject A の記憶は沈まない（テナント全体 recall でも A は残る）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");

    const alice = await createEmbeddedMemory(stores, [1, 0], {
      digest: "alice-memory",
      subjectId: "alice",
      decayBaseSeq: 0,
      decayFloorSeq: DECAY_FLOOR_SEQ,
      halfLifeRecalls: HALF_LIFE_RECALLS,
      decayFloorAt: FAR_FUTURE,
    });
    const bob = await createEmbeddedMemory(stores, [0, 1], {
      digest: "bob-memory",
      subjectId: "bob",
      decayBaseSeq: 0,
      decayFloorSeq: DECAY_FLOOR_SEQ,
      halfLifeRecalls: HALF_LIFE_RECALLS,
      decayFloorAt: FAR_FUTURE,
    });

    for (let i = 0; i < DECAY_FLOOR_SEQ + 2; i += 1) {
      await runtime.recall(bobCtx, {
        vector: [0, 1],
        scoreThreshold: 0,
        activityCounting: "subject",
      });
    }

    const bobResult = await runtime.recall(bobCtx, {
      vector: [0, 1],
      scoreThreshold: 0,
      activityCounting: "subject",
    });
    expect(bobResult.memories.map((m) => m.memoryId)).not.toContain(bob.id);

    const aliceResult = await runtime.recall(aliceCtx, { vector: [1, 0], scoreThreshold: 0 });
    expect(aliceResult.memories.map((m) => m.memoryId)).toContain(alice.id);

    const tenantWideResult = await runtime.recall(tenantCtx, {
      text: undefined,
      vector: [1, 1],
      scoreThreshold: 0,
      limit: 10,
    });
    const returnedIds = tenantWideResult.memories.map((m) => m.memoryId);
    expect(returnedIds).toContain(alice.id);
    expect(returnedIds).not.toContain(bob.id);
  });

  it("'subject' でも ctx.subjectId が無い（テナント全体）recall は T を進める（既定と同じ扱い）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");

    const alice = await createEmbeddedMemory(stores, [1, 0], {
      digest: "alice-memory",
      subjectId: "alice",
      decayBaseSeq: 0,
      decayFloorSeq: DECAY_FLOOR_SEQ,
      halfLifeRecalls: HALF_LIFE_RECALLS,
      decayFloorAt: FAR_FUTURE,
    });

    for (let i = 0; i < DECAY_FLOOR_SEQ + 2; i += 1) {
      await runtime.recall(tenantCtx, {
        vector: [1, 1],
        scoreThreshold: 0,
        activityCounting: "subject",
      });
    }

    const aliceResult = await runtime.recall(aliceCtx, { vector: [1, 0], scoreThreshold: 0 });
    expect(aliceResult.memories.map((m) => m.memoryId)).not.toContain(alice.id);
  });

  it("decay_clock='wall' のテナントでは activityCounting: 'subject' を渡しても何も進まない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0, 1], {
      digest: "bob-memory",
      subjectId: "bob",
      decayBaseSeq: 0,
      decayFloorSeq: DECAY_FLOOR_SEQ,
      halfLifeRecalls: HALF_LIFE_RECALLS,
      decayFloorAt: FAR_FUTURE,
    });

    for (let i = 0; i < DECAY_FLOOR_SEQ + 2; i += 1) {
      await runtime.recall(bobCtx, {
        vector: [0, 1],
        scoreThreshold: 0,
        activityCounting: "subject",
      });
    }

    expect(await stores.tenantSettingsStore.getActivitySeq(tenantCtx)).toBe(0);
    expect(await stores.tenantSettingsStore.hasSubjectActivityCounters(tenantCtx)).toBe(false);
  });

  it("一度も 'subject' を使っていないテナントでは、段1へ渡す VectorFilter.decayFloorSeqUsesSubjectCounters は常に false のまま——tenant_subject_activity を一度も参照しない、という決めたこと4 の配線そのものを検査する", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");

    await createEmbeddedMemory(stores, [1, 0], {
      digest: "alice-memory",
      subjectId: "alice",
      decayBaseSeq: 0,
      decayFloorSeq: DECAY_FLOOR_SEQ,
      halfLifeRecalls: HALF_LIFE_RECALLS,
      decayFloorAt: FAR_FUTURE,
    });

    // `vectorStore.search` を薄く包んで段1の VectorFilter を捕まえる。返る記憶はどちらの値でも変わらない
    // （`tenant_subject_activity` に行が無ければ `COALESCE(..., 0)` で同じ値になる）ので、この歯が無ければ配線の劣化はどの歯にも引っかからない。
    const capturedFilters: Array<boolean | undefined> = [];
    const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
    stores.vectorStore.search = (async (...args: Parameters<typeof originalSearch>) => {
      capturedFilters.push(args[3].filter.decayFloorSeqUsesSubjectCounters);
      return originalSearch(...args);
    }) as typeof stores.vectorStore.search;

    expect(await stores.tenantSettingsStore.hasSubjectActivityCounters(tenantCtx)).toBe(false);

    await runtime.recall(aliceCtx, { vector: [1, 0], scoreThreshold: 0 });

    expect(capturedFilters.length).toBeGreaterThan(0);
    for (const captured of capturedFilters) {
      expect(captured).not.toBe(true);
    }
  });
});
