import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 測るのはゲート軸（`decayFloorAt` を割ったら返らない）だけ。`Clock` を可変にするのは、選別が「報告した時刻」と「その後に読み直す時刻」が別でないと現れないため。`@mnemora/testkit` には依存しない。 */

const T0 = new Date("2026-06-01T00:00:00.000Z");
const T1 = new Date("2026-06-05T00:00:00.000Z");
const T2 = new Date("2026-06-20T00:00:00.000Z");
/** 作成時に両方へ与える忘却の床。`T1 < FLOOR < T2`。 */
const FLOOR = new Date("2026-06-10T00:00:00.000Z");

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  let now = T0;
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
    clock: { now: () => now },
  });
  return {
    runtime,
    stores,
    setNow: (next: Date) => {
      now = next;
    },
  };
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  // 半減期は意図的に長くする（10年）: 短いと `total` が段2の閾値を割り、ゲートで落ちたのか閾値で落ちたのか区別できなくなる。
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
    recordedAt: T0,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: FLOOR,
    embeddingStatus: "ready",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — ⭐ 使用報告した記憶だけが居残り、報告しなかった記憶は同じ recall() から落ちる", () => {
  it("A を使用報告し B を報告しないと、T2 の recall() で A は返り B は filtered(decayed) になる", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    const used = await createEmbeddedMemory(stores, [1, 0], { digest: "used" });
    const unused = await createEmbeddedMemory(stores, [1, 0], { digest: "unused" });

    setNow(T1);
    const first = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const firstIds = first.memories.map((m) => m.memoryId);
    expect(firstIds).toContain(used.id);
    expect(firstIds).toContain(unused.id);

    const report = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: first.recallId,
      usedMemoryIds: [used.id],
    });
    expect(report.memoryIds).toEqual([used.id]);

    const usedAfterReport = await stores.memoryStore.get(ctx, used.id);
    const unusedAfterReport = await stores.memoryStore.get(ctx, unused.id);
    expect(usedAfterReport?.lastReinforcedAt).not.toBeNull();
    expect(unusedAfterReport?.lastReinforcedAt).toBeNull();
    expect(usedAfterReport!.decayFloorAt.getTime()).toBe(
      defaultDecayStrategy
        .floorAt({
          recordedAt: T0,
          lastReinforcedAt: T1,
          strength: usedAfterReport!.strength,
          halfLifeHours: usedAfterReport!.halfLifeHours,
        })
        .getTime(),
    );
    expect(usedAfterReport!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(unusedAfterReport!.decayFloorAt.getTime()).toBe(FLOOR.getTime());
    expect(unusedAfterReport!.decayFloorAt.getTime()).toBeLessThan(T2.getTime());

    setNow(T2);
    const second = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const secondIds = second.memories.map((m) => m.memoryId);

    expect(secondIds).toContain(used.id);
    expect(secondIds).not.toContain(unused.id);

    expect(second.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
  });

  it("対照条件: どちらも使用報告しなければ、T2 の recall() では両方とも落ちる（歯が『A は何をしても残る』で通っていないことの検算）", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    const first = await createEmbeddedMemory(stores, [1, 0], { digest: "one" });
    const second = await createEmbeddedMemory(stores, [1, 0], { digest: "two" });

    setNow(T1);
    const before = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(before.memories.map((m) => m.memoryId)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );

    // ⛔ ここで `observe({ kind: 'memory_usage' })` を呼ばない——それがこの対照条件である。

    setNow(T2);
    const after = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const ids = after.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(first.id);
    expect(ids).not.toContain(second.id);
    expect(after.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 2,
      countKind: "exact",
    });
  });
});
