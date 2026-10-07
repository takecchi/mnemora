import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `event-store-conformance.ts` には足さない: `FakeEventStore` は core の runtime テスト専用の別系統（core は testkit に依存しない）。
 * 挿入順と `at` 順をわざと不一致にする: 一致する並びだと、どちらでソートしても同じ結果になって変異が生き残る。
 * 期待値は実装の定数ではなくこのファイルのリテラルな `Date` から作る: 共有すると検査対象と期待値が一緒に壊れて変異が素通りする。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

let contentHashCounter = 0;

/** 意図的に独立したコピー: core は testkit に依存せず、別系統のテストと結合させない。 */
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

/** 意図的に独立したコピー。`memoryId` は実在する Memory の id が要るので、既定値を持たせない。 */
function newEvent(memoryId: string, overrides: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "created",
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
    ...overrides,
  };
}

const T1 = new Date("2026-01-01T00:00:00.000Z");
const T2 = new Date("2026-01-02T00:00:00.000Z");
const T3 = new Date("2026-01-03T00:00:00.000Z");

describe("FakeEventStore.list — EventStore.list の契約（ADR 0042）", () => {
  it("at 昇順で返す（挿入順ではない）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const e3 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T3 }));
    const e1 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T2 }));

    const listed = await stores.eventStore.list(ctx, {});

    expect(listed.map((event) => event.id)).toEqual([e1.id, e2.id, e3.id]);
  });

  it("limit は at 昇順に並べ替えた後に適用する（挿入順の先頭 n 件ではない）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const e3 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T3 }));
    const e1 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T1 }));
    await stores.eventStore.append(ctx, newEvent(memory.id, { at: T2 }));

    const limited = await stores.eventStore.list(ctx, { limit: 1 });

    expect(limited.map((event) => event.id)).toEqual([e1.id]);
    expect(limited.map((event) => event.id)).not.toEqual([e3.id]);
  });

  it("since は境界を含む（at >= since）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.eventStore.append(ctx, newEvent(memory.id, { at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T2 }));
    const e3 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T3 }));

    const listed = await stores.eventStore.list(ctx, { since: T2 });

    expect(listed.map((event) => event.id)).toEqual([e2.id, e3.id]);
  });

  it("until は境界を含む（at <= until）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const e1 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T2 }));
    await stores.eventStore.append(ctx, newEvent(memory.id, { at: T3 }));

    const listed = await stores.eventStore.list(ctx, { until: T2 });

    expect(listed.map((event) => event.id)).toEqual([e1.id, e2.id]);
  });

  it("list を呼んだ後も backing.events（store.events）の並びは挿入順のまま変わらない（共有配列を in-place で壊さない）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    // store.events は FakeMemoryStore.updateStatusWithEvent と共有される配列。list が in-place で sort すると runtime.test.ts を静かに壊す。
    const e3 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T3 }));
    const e1 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent(memory.id, { at: T2 }));

    await stores.eventStore.list(ctx, {});

    expect(stores.eventStore.events.map((event) => event.id)).toEqual([e3.id, e1.id, e2.id]);
  });
});
