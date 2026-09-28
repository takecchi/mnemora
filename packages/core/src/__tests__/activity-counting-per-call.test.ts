import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * [ADR 0348](../../../docs/decisions/0348-activity-counting-per-call.md)
 * （Issue #338、オーナーの回答 ask_human 61355570「呼び出す際の引数で指定できるように
 * はできない？」）の歯。
 *
 * 本 Issue の症状の再現と修理を確かめる:
 * - 既定（`activityCounting` 省略、`'tenant'`）では、subject B に絞った recall を
 *   繰り返すと、subject A の記憶も沈む（テナント単位のカウンタ `T` だけを見るため。
 *   これは本 ADR 以前と1バイトも変わらない挙動——回帰確認）。
 * - `activityCounting: "subject"` で subject B に絞った recall を繰り返しても、
 *   subject A の記憶は沈まない（subject 単位のカウンタ `S_bob` だけが進み、`T` には
 *   触れない）。テナント全体を見る recall でも A は残り、B は沈む
 *   （読み取りは常に `T + S_x` を使うため）。
 *
 * `packages/core` 自身のテストなので `@mnemora/testkit` には依存しない
 * （`runtime-fakes.ts` 冒頭のコメントと同じ理由）。DB を要さないため手元で実行できる。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100); // 壁時計では絶対に沈まない
const TENANT_ID = "tenant-338";
const tenantCtx: Ctx = { tenantId: TENANT_ID };
const aliceCtx: Ctx = { tenantId: TENANT_ID, subjectId: "alice" };
const bobCtx: Ctx = { tenantId: TENANT_ID, subjectId: "bob" };

// halfLifeRecalls=2、既定の閾値0.05（DEFAULT_DECAY_THRESHOLD）における床
// （ADR 0311 が実測した式 ceil(halfLife * log2(1/threshold)) と同じ）。
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

describe("recall() — activityCounting（ADR 0348、Issue #338）", () => {
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

    // activityCounting を渡さない——既定 'tenant' のまま。B に絞った recall を
    // 繰り返し、T（テナント単位のカウンタ）を DECAY_FLOOR_SEQ を超えるまで進める。
    for (let i = 0; i < DECAY_FLOOR_SEQ + 2; i += 1) {
      await runtime.recall(bobCtx, { vector: [0, 1], scoreThreshold: 0 });
    }

    // A は一度も recall されていないのに、T が進んだことで沈む。
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

    // activityCounting: "subject" を明示。B に絞った recall を繰り返すと、
    // S_bob だけが進み、T は動かない。
    for (let i = 0; i < DECAY_FLOOR_SEQ + 2; i += 1) {
      await runtime.recall(bobCtx, {
        vector: [0, 1],
        scoreThreshold: 0,
        activityCounting: "subject",
      });
    }

    // B は S_bob が床を超えたので沈む。
    const bobResult = await runtime.recall(bobCtx, {
      vector: [0, 1],
      scoreThreshold: 0,
      activityCounting: "subject",
    });
    expect(bobResult.memories.map((m) => m.memoryId)).not.toContain(bob.id);

    // A は S_alice=0・T=0 のまま——subject A に絞った recall でも生き残る。
    const aliceResult = await runtime.recall(aliceCtx, { vector: [1, 0], scoreThreshold: 0 });
    expect(aliceResult.memories.map((m) => m.memoryId)).toContain(alice.id);

    // テナント全体を見る recall でも、A は残り B は沈んでいる
    // （読み取りは常に T + S_x を使うため——activityCounting の値には依存しない）。
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

    // ctx.subjectId を指定しない（テナント全体）recall を activityCounting: "subject"
    // で繰り返す——「絞っていなければ T を進める」の分岐。
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
    // decay_clock を設定しない = 既定 'wall'。
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
});
