import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `fake-event-target-belongs-to-ctx-tenant.test.ts` は、2者・群の口では「先頭のイベント」が別テナントを指す入力だけを
 * 縛っていた。呼び出しが運ぶイベントは、**どれが**別テナントの記憶を指していても `FakeMemoryStore` は断る
 * （`PostgresMemoryStore` と同じ。イベントを積むすべてのメンバーの指し先を、書く前に確かめる）。この歯は、先頭以外のイベントを縛る。
 *
 * 約束の出所: `FakeMemoryStore.assertEventTargetOwn` の TSDoc（「イベントを積む前に確かめる」）。
 * testkit の `InMemoryMemoryStore` 版は `packages/testkit/src/__tests__/in-memory-event-target-every-event.test.ts`。
 */

const A: Ctx = { tenantId: "fake-event-every-a" };
const B: Ctx = { tenantId: "fake-event-every-b" };
const NOT_FOUND = /^FakeMemoryStore: memory not found for tenant: /;
let hashCounter = 0;

function newMemory(ctx: Ctx): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${hashCounter}`,
    contentHash: `fake-event-every-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-event-every" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 168,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

function setup() {
  const stores = createFakeRuntimeStores();
  const store = stores.memoryStore;
  const backing = (store as unknown as { backing: { events: Array<{ memoryId: string | null }> } })
    .backing;
  const make = (ctx: Ctx) => store.createMemory(ctx, newMemory(ctx));
  const ev = (memoryId: string | null): NewMemoryEvent => ({
    tenantId: "ignored",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: { probe: true },
  });
  const eventCount = (id: MemoryId) => backing.events.filter((e) => e.memoryId === id).length;
  const statusOf = async (id: MemoryId) => (await store.get(A, id))?.status;
  return { store, backing, make, ev, eventCount, statusOf };
}

describe("別テナントを指すイベントは、先頭以外のものでも書かずに断る（FakeMemoryStore）", () => {
  it("resolveContestedPair: 2つ目のイベントが別テナントを指しても断る。何も書かない", async () => {
    const { store, backing, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [p1, p2] = [await make(A), await make(A)] as const;
    await store.markContestedPair!(
      A,
      { id: p1.id, event: ev(p1.id) },
      { id: p2.id, event: ev(p2.id) },
    );
    const total = backing.events.length;

    await expect(
      store.resolveContestedPair!(
        A,
        { id: p1.id, status: "active", event: ev(p1.id) },
        { id: p2.id, status: "superseded", supersededById: p1.id, event: ev(b.id) },
      ),
    ).rejects.toThrow(NOT_FOUND);

    expect(eventCount(b.id)).toBe(0);
    expect(backing.events.length).toBe(total);
    expect(await statusOf(p1.id)).toBe("contested");
    expect(await statusOf(p2.id)).toBe("contested");
  });

  it.each([1, 2])(
    "markContestedGroup: %i 番目（先頭でない）のメンバーのイベントが別テナントを指しても断る。何も書かない",
    async (position) => {
      const { store, backing, make, ev, eventCount, statusOf } = setup();
      const b = await make(B);
      const members = [await make(A), await make(A), await make(A)];
      const total = backing.events.length;
      const input = members.map((m, i) => ({ id: m.id, event: ev(i === position ? b.id : m.id) }));

      await expect(store.markContestedGroup!(A, input)).rejects.toThrow(NOT_FOUND);

      expect(eventCount(b.id)).toBe(0);
      expect(backing.events.length).toBe(total);
      for (const m of members) expect(await statusOf(m.id)).toBe("active");
    },
  );

  it.each([1, 2])(
    "resolveContestedGroup: %i 番目（先頭でない）のメンバーのイベントが別テナントを指しても断る。何も書かない",
    async (position) => {
      const { store, backing, make, ev, eventCount, statusOf } = setup();
      const b = await make(B);
      const members = [await make(A), await make(A), await make(A)];
      await store.markContestedGroup!(
        A,
        members.map((m) => ({ id: m.id, event: ev(m.id) })),
      );
      const total = backing.events.length;
      const input = members.map((m, i) => ({
        id: m.id,
        status: i === 0 ? ("active" as const) : ("superseded" as const),
        ...(i === 0 ? {} : { supersededById: members[0]!.id }),
        event: ev(i === position ? b.id : m.id),
      }));

      await expect(store.resolveContestedGroup!(A, input)).rejects.toThrow(NOT_FOUND);

      expect(eventCount(b.id)).toBe(0);
      expect(backing.events.length).toBe(total);
      for (const m of members) expect(await statusOf(m.id)).toBe("contested");
    },
  );
});
