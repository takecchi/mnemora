import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * #1096・#1183 の外側に残っていた CHECK 制約と型の変換を、testkit の fixture も Postgres と同じく拒む。
 * - `memories_check`: `provenance.kind` が `stated`/`inferred` なら `sourceObservationId` が要る。
 * - `memories_decay_seq_non_negative` と `bigint`: `decayBaseSeq`・`decayFloorSeq` は 0 以上の整数で、bigint に収まる。
 * - `memories_half_life_recalls_range` と `real`: `halfLifeRecalls` は `(0, ∞)` で、float4 に収まる（0 に丸まらない）。
 * - `memory_events_check`: `kind: "events_purged"` の `memoryId` は null。
 *
 * 【実測 2026-09-27】以前は testkit の fixture が、どれも受け付けて記録していた（Postgres は 23514・22P02・22003 で拒む）。
 */

interface Kit {
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return { memoryStore, eventStore: new InMemoryEventStore(memoryStore, memoryStore.events) };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return { memoryStore: new PostgresMemoryStore(db), eventStore: new PostgresEventStore(db) };
    },
  ],
];

const ctx: Ctx = { tenantId: "remaining-check-constraints" };

afterAll(async () => {
  await closeTestClient();
});

const ACTIVITY = { decayBaseSeq: 0, decayFloorSeq: 10, halfLifeRecalls: 5 };

const CASES: Array<[string, Partial<NewMemory>]> = [
  [
    "stated で sourceObservationId が無い",
    {
      provenance: { kind: "stated", sourceObservationId: "obs-x", at: "2026-09-27T00:00:00.000Z" },
      sourceObservationId: null,
    },
  ],
  [
    "inferred で sourceObservationId が無い",
    {
      provenance: { kind: "inferred", basis: { memoryIds: [], observationIds: [] } },
      sourceObservationId: null,
    },
  ],
  ["decayBaseSeq が負", { ...ACTIVITY, decayBaseSeq: -1 }],
  ["decayFloorSeq が負", { ...ACTIVITY, decayFloorSeq: -1 }],
  ["decayBaseSeq が整数でない", { ...ACTIVITY, decayBaseSeq: 1.5 }],
  ["decayFloorSeq が NaN", { ...ACTIVITY, decayFloorSeq: Number.NaN }],
  ["decayBaseSeq が bigint に収まらない", { ...ACTIVITY, decayBaseSeq: 2 ** 63 }],
  ["halfLifeRecalls が 0", { ...ACTIVITY, halfLifeRecalls: 0 }],
  ["halfLifeRecalls が負", { ...ACTIVITY, halfLifeRecalls: -1 }],
  ["halfLifeRecalls が NaN", { ...ACTIVITY, halfLifeRecalls: Number.NaN }],
  ["halfLifeRecalls が Infinity", { ...ACTIVITY, halfLifeRecalls: Number.POSITIVE_INFINITY }],
  ["halfLifeRecalls が float4 に収まらない", { ...ACTIVITY, halfLifeRecalls: 1e300 }],
  ["halfLifeRecalls が float4 で 0 に丸まる", { ...ACTIVITY, halfLifeRecalls: 1e-300 }],
];

describe.each(KITS)("#1183 の外側の CHECK 制約（%s）", (_name, build) => {
  it.each(CASES)("createMemory は %s 入力を拒む", async (label, override) => {
    const { memoryStore } = await build();
    await expect(
      memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `chk-${label}`, ...override }),
      ),
    ).rejects.toThrow();
  });

  it("活動時計の3つ組が値域の内側なら通る（陽性対照）", async () => {
    const { memoryStore } = await build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "chk-ok", ...ACTIVITY }),
    );
    expect(m.halfLifeRecalls).toBe(5);
  });

  it("EventStore.append は memoryId を持つ events_purged を拒み、何も書かない", async () => {
    const { memoryStore, eventStore } = await build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "chk-event" }),
    );
    await expect(
      eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: m.id,
        kind: "events_purged",
        actor: { type: "system" },
        meta: {},
      }),
    ).rejects.toThrow();
    expect(await eventStore.list(ctx, { memoryId: m.id })).toHaveLength(0);
  });
});
