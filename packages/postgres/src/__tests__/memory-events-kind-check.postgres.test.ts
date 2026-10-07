import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

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

const ctx: Ctx = { tenantId: "memory-events-kind-check" };

afterAll(async () => {
  await closeTestClient();
});

function eventWithKind(memoryId: string, kind: string): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: kind as NewMemoryEvent["kind"],
    actor: { type: "system" },
    meta: {},
  };
}

describe.each(KITS)("memory_events の kind の検査（%s）", (_name, build) => {
  it("EventStore.append は MemoryEventKind に無い kind を拒み、何も書かない", async () => {
    const { memoryStore, eventStore } = await build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-check-append" }),
    );
    const before = (await eventStore.list(ctx, { memoryId: m.id })).length;

    await expect(eventStore.append(ctx, eventWithKind(m.id, "contested"))).rejects.toThrow();

    expect((await eventStore.list(ctx, { memoryId: m.id })).length).toBe(before);
  });

  it("markContestedPair は MemoryEventKind に無い kind のイベントを拒み、2件とも状態を変えない", async () => {
    const { memoryStore, eventStore } = await build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-check-a" }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-check-b" }),
    );

    await expect(
      memoryStore.markContestedPair!(
        ctx,
        { id: a.id, event: eventWithKind(a.id, "updated") },
        { id: b.id, event: eventWithKind(b.id, "contested") },
      ),
    ).rejects.toThrow();

    expect((await memoryStore.get(ctx, a.id))?.status).toBe("active");
    expect((await memoryStore.get(ctx, b.id))?.status).toBe("active");
    const events = await eventStore.list(ctx, {});
    expect(events.filter((e) => e.memoryId === a.id || e.memoryId === b.id)).toHaveLength(0);
  });

  it("MemoryEventKind の値（updated）なら、同じ口は通る（陽性対照）", async () => {
    const { memoryStore, eventStore } = await build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-check-ok" }),
    );
    await eventStore.append(ctx, eventWithKind(m.id, "updated"));
    expect(await eventStore.list(ctx, { memoryId: m.id })).toHaveLength(1);
  });
});
