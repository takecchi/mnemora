import { describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * #1096・#1183 の外側に残っていた CHECK 制約と型の変換を、testkit の fixture も Postgres と同じく拒む。
 * 2実装を並べた歯は `packages/postgres/src/__tests__/remaining-check-constraints.postgres.test.ts`（DB が要る）。
 * ここは DB 無しで走る側の歯で、文面と「何も書かない」を縛る。
 */

const ctx: Ctx = { tenantId: "remaining-check-constraints" };
const ACTIVITY = { decayBaseSeq: 0, decayFloorSeq: 10, halfLifeRecalls: 5 };

const CASES: Array<[string, Partial<NewMemory>, RegExp]> = [
  [
    "stated で sourceObservationId が無い",
    {
      provenance: { kind: "stated", sourceObservationId: "obs-x", at: "2026-09-27T00:00:00.000Z" },
      sourceObservationId: null,
    },
    /^InMemoryMemoryStore: provenance\.kind "stated" requires sourceObservationId$/,
  ],
  [
    "inferred で sourceObservationId が無い",
    {
      provenance: { kind: "inferred", basis: { memoryIds: [], observationIds: [] } },
      sourceObservationId: null,
    },
    /^InMemoryMemoryStore: provenance\.kind "inferred" requires sourceObservationId$/,
  ],
  [
    "decayBaseSeq が負",
    { ...ACTIVITY, decayBaseSeq: -1 },
    /^InMemoryMemoryStore: decayBaseSeq must not be negative \(got -1\)$/,
  ],
  [
    "decayFloorSeq が整数でない",
    { ...ACTIVITY, decayFloorSeq: 1.5 },
    /^InMemoryMemoryStore: decayFloorSeq must be an integer \(got 1\.5\)$/,
  ],
  [
    "decayBaseSeq が bigint に収まらない",
    { ...ACTIVITY, decayBaseSeq: 2 ** 63 },
    /^InMemoryMemoryStore: decayBaseSeq must fit in a Postgres bigint/,
  ],
  [
    "halfLifeRecalls が 0",
    { ...ACTIVITY, halfLifeRecalls: 0 },
    /^InMemoryMemoryStore: halfLifeRecalls out of range \(0, ∞\): 0$/,
  ],
  [
    "halfLifeRecalls が float4 に収まらない",
    { ...ACTIVITY, halfLifeRecalls: 1e300 },
    /halfLifeRecalls does not fit in a Postgres "real" \(float4\) column/,
  ],
  [
    "halfLifeRecalls が float4 で 0 に丸まる",
    { ...ACTIVITY, halfLifeRecalls: 1e-300 },
    /halfLifeRecalls does not fit in a Postgres "real" \(float4\) column .*rounds to 0/,
  ],
];

describe("testkit の fixture は #1183 の外側の CHECK 制約を写す", () => {
  it.each(CASES)("createMemory: %s", async (label, override, message) => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `chk-${label}`, ...override }),
      ),
    ).rejects.toThrow(message);
    expect(store.outboxJobs).toHaveLength(0);
  });

  it("活動時計の欄を省略（null）するのは「この軸を使わない」であり、拒まない", async () => {
    const store = new InMemoryMemoryStore();
    const m = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "chk-null",
        decayBaseSeq: null,
        decayFloorSeq: null,
        halfLifeRecalls: null,
      }),
    );
    expect(m.halfLifeRecalls).toBeNull();
  });

  it("EventStore.append: memoryId を持つ events_purged を拒み、何も書かない", async () => {
    const store = new InMemoryMemoryStore();
    const events = new InMemoryEventStore(store, store.events);
    const m = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "chk-ev" }),
    );
    await expect(
      events.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: m.id,
        kind: "events_purged",
        actor: { type: "system" },
        meta: {},
      }),
    ).rejects.toThrow(/^memory_events\.memoryId must be null for kind "events_purged"/);
    expect(store.events).toHaveLength(0);
  });
});
