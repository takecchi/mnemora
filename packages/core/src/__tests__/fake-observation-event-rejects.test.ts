import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * core の Fake（`FakeMemoryStore`・`FakeEventStore`）を、testkit の fixture と `@mnemora/postgres` が拒む3つの形に揃え、
 * `updateStatusWithEvent` を原子的にした歯（9回目の棚卸し）:
 * - Observation の日時（`recordedAt`・`occurredAt`・`validFrom`・`validUntil`）が Invalid Date → 投げる
 * - イベントの `kind` が列挙に無い → 投げる
 * - `kind: "events_purged"` なのに `memoryId` が `null` でない → 投げる
 * - `updateStatusWithEvent` で、イベントが書けない（上の2つや Invalid Date の `at`）ときは、状態を書き換えない
 *   （Postgres は1トランザクションで巻き戻り、fixture は状態を書き換える前に検査する）。
 *
 * Postgres と fixture の側の歯は `packages/postgres/src/__tests__/observation-event-input-current-behaviour.postgres.test.ts`。
 */

const ctx: Ctx = { tenantId: "fake-observation-event" };

function observationInput(over: Partial<NewObservation>): NewObservation {
  return {
    tenantId: ctx.tenantId,
    kind: "utterance",
    payload: { text: "t" },
    recordedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as NewObservation;
}

function memoryInput(contentHash: string): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash,
    digest: "本文",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "b" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2027-01-01T00:00:00Z"),
    embeddingStatus: "pending",
  } as NewMemory;
}

describe.each(["createObservation", "createObservationWithOutbox"] as const)(
  "FakeMemoryStore.%s は Invalid Date の日時を拒む（fixture・Postgres と同じ）",
  (method) => {
    it.each(["recordedAt", "occurredAt", "validFrom", "validUntil"] as const)(
      "%s",
      async (field) => {
        const { memoryStore } = createFakeRuntimeStores();
        const input = observationInput({ [field]: new Date(Number.NaN) });
        const call =
          method === "createObservation"
            ? memoryStore.createObservation(ctx, input)
            : memoryStore.createObservationWithOutbox(ctx, input, ["extract"]);
        await expect(call).rejects.toThrow(new RegExp(`${field} must be a valid Date`));
      },
    );

    it("正しい日時は、今までどおり受け付ける", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const input = observationInput({ occurredAt: new Date("2026-01-01T00:00:00Z") });
      const call =
        method === "createObservation"
          ? memoryStore.createObservation(ctx, input)
          : memoryStore.createObservationWithOutbox(ctx, input, ["extract"]);
      await expect(call).resolves.toBeDefined();
    });
  },
);

const BAD_EVENTS: Array<[string, (memoryId: string) => Partial<NewMemoryEvent>, RegExp]> = [
  ["kind が列挙に無い", () => ({ kind: "bogus" as never }), /memory_events\.kind must be one of/],
  [
    "events_purged なのに memoryId が null でない",
    () => ({ kind: "events_purged" }),
    /memory_events\.memoryId must be null for kind "events_purged"/,
  ],
];

function event(memoryId: string, over: Partial<NewMemoryEvent>): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "forgotten",
    actor: { type: "system" },
    meta: {},
    ...over,
  } as NewMemoryEvent;
}

describe("FakeEventStore.append は、fixture・Postgres と同じ2つの形を拒む", () => {
  it.each(BAD_EVENTS)("%s", async (_label, over, message) => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, memoryInput("append"));
    await expect(eventStore.append(ctx, event(memory.id, over(memory.id)))).rejects.toThrow(
      message,
    );
    expect(await eventStore.list(ctx, { memoryId: memory.id })).toEqual([]);
  });

  // fixture・Postgres と同じく、ここに挙げた形は拒まない（揃えたのは上の2つだけで、形の検査は足していない）。
  it.each([
    ["actor.type が列挙に無い", { actor: { type: "robot" } as never }],
    ["actor が null", { actor: null as never }],
    ["meta が null", { meta: null as never }],
    ["sizeBeforeBytes が負", { sizeBeforeBytes: -1 }],
    ["memoryId が null で kind が created", { memoryId: null, kind: "created" as const }],
  ])("%s は、fixture・Postgres と同じく受け付ける", async (_label, over) => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, memoryInput(`append-accept-${_label}`));
    await expect(eventStore.append(ctx, event(memory.id, over))).resolves.toBeDefined();
  });

  it("正しいイベントは、今までどおり書く", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, memoryInput("append-ok"));
    await expect(eventStore.append(ctx, event(memory.id, {}))).resolves.toMatchObject({
      kind: "forgotten",
    });
  });
});

describe("FakeMemoryStore.updateStatusWithEvent は、イベントが書けないとき状態を書き換えない（原子的）", () => {
  it.each([
    ...BAD_EVENTS,
    [
      "at が Invalid Date",
      () => ({ at: new Date(Number.NaN) }),
      /memory_events\.at must be a valid Date/,
    ] as [string, (memoryId: string) => Partial<NewMemoryEvent>, RegExp],
  ])("%s: 投げ、status は active のまま、イベントも残らない", async (_label, over, message) => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, memoryInput(`usw-${_label}`));
    await expect(
      memoryStore.updateStatusWithEvent(
        ctx,
        memory.id,
        "forgotten",
        { expectedStatus: "active" },
        event(memory.id, over(memory.id)),
      ),
    ).rejects.toThrow(message);
    expect((await memoryStore.get(ctx, memory.id))?.status).toBe("active");
    expect(await eventStore.list(ctx, { memoryId: memory.id })).toEqual([]);
  });

  it("正しいイベントなら、今までどおり状態とイベントの両方を書く", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, memoryInput("usw-ok"));
    await memoryStore.updateStatusWithEvent(
      ctx,
      memory.id,
      "forgotten",
      { expectedStatus: "active" },
      event(memory.id, {}),
    );
    expect((await memoryStore.get(ctx, memory.id))?.status).toBe("forgotten");
    expect((await eventStore.list(ctx, { memoryId: memory.id })).map((e) => e.kind)).toEqual([
      "forgotten",
    ]);
  });
});
