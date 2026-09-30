import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryEventSchema,
  ObservationSchema,
  type Ctx,
  type EventStore,
  type MemoryStore,
  type NewMemoryEvent,
  type NewObservation,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Observation とイベントの書き込みの口が入力の中身をどう扱うかの、今の振る舞い（9回目の棚卸し）。
 * `MemoryStore.createObservation`・`EventStore.append`・`MemoryEvent.memoryId` の TSDoc の歯。
 * `@mnemora/postgres` と testkit の fixture で縛り、2つが違うところ（`payload: undefined`）は、それぞれの今の
 * 振る舞いのまま縛る（揃えるかはオーナーへの問いの待ち）。整数でない `sizeBeforeBytes` は、ADR 0434 で fixture を
 * Postgres に揃えたので、どちらも拒む。
 * core の Fake の側は `packages/core/src/__tests__/fake-observation-event-rejects.test.ts`。
 *
 * ⚠ 望ましい姿の主張ではない。変えるときは、この歯ごと書き換えること。
 */

const ctx: Ctx = { tenantId: "observation-event-input-a" };
const other: Ctx = { tenantId: "observation-event-input-b" };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

interface Kit {
  name: "Postgres" | "fixture";
  ms: MemoryStore;
  es: EventStore;
}

const KITS: Array<[Kit["name"], () => Promise<Kit>]> = [
  [
    "Postgres",
    async () => {
      const { db } = await getTestClient();
      return { name: "Postgres", ms: new PostgresMemoryStore(db), es: new PostgresEventStore(db) };
    },
  ],
  [
    "fixture",
    async () => {
      const ms = new InMemoryMemoryStore();
      return { name: "fixture", ms, es: new InMemoryEventStore(ms, ms.events) };
    },
  ],
];

const OBSERVATION_WRITES = [
  ["createObservation", (k: Kit, input: NewObservation) => k.ms.createObservation(ctx, input)],
  [
    "createObservationWithOutbox",
    async (k: Kit, input: NewObservation) =>
      (await k.ms.createObservationWithOutbox(ctx, input, ["extract"])).observation,
  ],
] as const;

let n = 0;
function observation(over: Record<string, unknown>): NewObservation {
  n += 1;
  return {
    tenantId: ctx.tenantId,
    kind: "utterance",
    payload: { text: "t" },
    externalId: `ext-${n}`,
    recordedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as NewObservation;
}

describe.each(KITS)("Observation の入力（今の振る舞い）: %s", (kitName, build) => {
  describe.each(OBSERVATION_WRITES)("%s", (_method, write) => {
    it.each([
      ["kind が空文字", { kind: "" }],
      ["subjectId が空文字", { subjectId: "" }],
      ["externalId が空文字", { externalId: "" }],
      ["attributes の値が数", { attributes: { a: 1 } }],
    ])("%s は受け付け、返った値は ObservationSchema を通らない", async (_label, over) => {
      const kit = await build();
      const written = await write(kit, observation(over));
      expect(written.id).toBeDefined();
      expect(ObservationSchema.safeParse(written).success).toBe(false);
    });

    it.each([
      ["recordedAt が Invalid Date", { recordedAt: new Date(Number.NaN) }],
      ["occurredAt が Invalid Date", { occurredAt: new Date(Number.NaN) }],
    ])("%s は拒む", async (_label, over) => {
      const kit = await build();
      await expect(write(kit, observation(over))).rejects.toThrow();
    });

    it("tenantId が ctx と違っても、ctx のテナントとして書く", async () => {
      const kit = await build();
      const written = await write(kit, observation({ tenantId: other.tenantId }));
      expect(written.tenantId).toBe(ctx.tenantId);
      expect((await kit.ms.getObservation(ctx, written.id))?.tenantId).toBe(ctx.tenantId);
      await expect(kit.ms.getObservation(other, written.id)).resolves.toBeNull();
    });

    it(`payload が undefined は、${kitName === "Postgres" ? "拒む（Postgres だけ。列が NOT NULL）" : "受け付ける（fixture。Postgres とは違う）"}`, async () => {
      const kit = await build();
      const call = write(kit, observation({ payload: undefined }));
      if (kitName === "Postgres") {
        await expect(call).rejects.toThrow();
      } else {
        await expect(call).resolves.toMatchObject({ kind: "utterance" });
      }
    });
  });
});

function event(memoryId: string | null, over: Record<string, unknown>): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: {},
    ...over,
  } as NewMemoryEvent;
}

describe.each(KITS)("イベントの入力（今の振る舞い）: %s", (kitName, build) => {
  async function withMemory() {
    const kit = await build();
    const memory = await kit.ms.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `ev-${Math.random()}` }),
    );
    return { kit, memoryId: memory.id };
  }

  it.each([
    ["actor.type が列挙に無い", { actor: { type: "robot" } }],
    ["actor が null", { actor: null }],
    ["meta が null", { meta: null }],
    ["meta が配列", { meta: [1, 2] }],
    ["meta が文字列", { meta: "x" }],
    ["sizeBeforeBytes が負", { sizeBeforeBytes: -1 }],
  ])("append: %s は受け付け、返った値は MemoryEventSchema を通らない", async (_label, over) => {
    const { kit, memoryId } = await withMemory();
    const written = await kit.es.append(ctx, event(memoryId, over));
    expect(written.id).toBeDefined();
    expect(MemoryEventSchema.safeParse(written).success).toBe(false);
  });

  it("append: memoryId が null でも kind が events_purged 以外なら受け付ける（MemoryEventSchema も通る）", async () => {
    const { kit } = await withMemory();
    const written = await kit.es.append(ctx, event(null, { kind: "created" }));
    expect(written.memoryId).toBeNull();
    expect(MemoryEventSchema.safeParse(written).success).toBe(true);
  });

  it.each([
    ["kind が列挙に無い", (id: string) => event(id, { kind: "bogus" })],
    [
      "events_purged なのに memoryId が null でない",
      (id: string) => event(id, { kind: "events_purged" }),
    ],
    ["at が Invalid Date", (id: string) => event(id, { at: new Date(Number.NaN) })],
    ["memoryId が存在しない", () => event("00000000-0000-4000-8000-000000000000", {})],
  ])("append: %s は拒む", async (_label, make) => {
    const { kit, memoryId } = await withMemory();
    await expect(kit.es.append(ctx, make(memoryId))).rejects.toThrow();
  });

  // ADR 0434: fixture も Postgres（列が整数）と同じく拒む。
  it("append: sizeBeforeBytes が整数でない（1.5）は拒む", async () => {
    const { kit, memoryId } = await withMemory();
    await expect(kit.es.append(ctx, event(memoryId, { sizeBeforeBytes: 1.5 }))).rejects.toThrow();
  });

  it("append: tenantId が ctx と違っても、ctx のテナントとして書く", async () => {
    const { kit, memoryId } = await withMemory();
    const written = await kit.es.append(ctx, event(memoryId, { tenantId: other.tenantId }));
    expect(written.tenantId).toBe(ctx.tenantId);
    expect((await kit.es.list(ctx, { memoryId })).map((e) => e.id)).toEqual([written.id]);
    expect(await kit.es.list(other, { memoryId })).toEqual([]);
  });

  it.each([
    ["kind が列挙に無い", { kind: "bogus" }],
    ["at が Invalid Date", { at: new Date(Number.NaN) }],
  ])(
    "updateStatusWithEvent: イベントの %s は拒み、状態を書き換えない（イベントも残らない）",
    async (_label, over) => {
      const { kit, memoryId } = await withMemory();
      await expect(
        kit.ms.updateStatusWithEvent(
          ctx,
          memoryId,
          "forgotten",
          { expectedStatus: "active" },
          event(memoryId, { kind: "forgotten", ...over }),
        ),
      ).rejects.toThrow();
      expect((await kit.ms.get(ctx, memoryId))?.status).toBe("active");
      expect(await kit.es.list(ctx, { memoryId })).toEqual([]);
    },
  );

  it("updateStatusWithEvent: イベントの actor.type が列挙に無くても、状態とイベントの両方を書く", async () => {
    const { kit, memoryId } = await withMemory();
    const { event: written } = await kit.ms.updateStatusWithEvent(
      ctx,
      memoryId,
      "forgotten",
      { expectedStatus: "active" },
      event(memoryId, { kind: "forgotten", actor: { type: "robot" } }),
    );
    expect((await kit.ms.get(ctx, memoryId))?.status).toBe("forgotten");
    expect(MemoryEventSchema.safeParse(written).success).toBe(false);
  });
});
