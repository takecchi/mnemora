import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const A: Ctx = { tenantId: "event-target-every-a" };
const B: Ctx = { tenantId: "event-target-every-b" };
const NOT_FOUND = /^InMemoryMemoryStore: memory not found for tenant: /;

function setup() {
  const store = new InMemoryMemoryStore();
  let n = 0;
  const make = (ctx: Ctx) => {
    n += 1;
    return store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: `m${n}`,
        digest: `d${n}`,
        contentHash: `h-${ctx.tenantId}-${n}`,
      }),
    );
  };
  const ev = (memoryId: string | null): NewMemoryEvent => ({
    tenantId: "ignored",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: { probe: true },
  });
  const eventCount = (id: MemoryId) => store.events.filter((e) => e.memoryId === id).length;
  const statusOf = async (id: MemoryId) => (await store.get(A, id))?.status;
  return { store, make, ev, eventCount, statusOf };
}

describe("別テナントを指すイベントは、先頭以外のものでも書かずに断る（InMemoryMemoryStore）", () => {
  it("resolveContestedPair: 2つ目のイベントが別テナントを指しても断る。何も書かない", async () => {
    const { store, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [p1, p2] = [await make(A), await make(A)] as const;
    await store.markContestedPair!(
      A,
      { id: p1.id, event: ev(p1.id) },
      { id: p2.id, event: ev(p2.id) },
    );
    const total = store.events.length;

    await expect(
      store.resolveContestedPair!(
        A,
        { id: p1.id, status: "active", event: ev(p1.id) },
        { id: p2.id, status: "superseded", supersededById: p1.id, event: ev(b.id) },
      ),
    ).rejects.toThrow(NOT_FOUND);

    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    expect(await statusOf(p1.id)).toBe("contested");
    expect(await statusOf(p2.id)).toBe("contested");
  });

  it.each([1, 2])(
    "markContestedGroup: %i 番目（先頭でない）のメンバーのイベントが別テナントを指しても断る。何も書かない",
    async (position) => {
      const { store, make, ev, eventCount, statusOf } = setup();
      const b = await make(B);
      const members = [await make(A), await make(A), await make(A)];
      const total = store.events.length;
      const input = members.map((m, i) => ({ id: m.id, event: ev(i === position ? b.id : m.id) }));

      await expect(store.markContestedGroup!(A, input)).rejects.toThrow(NOT_FOUND);

      expect(eventCount(b.id)).toBe(0);
      expect(store.events.length).toBe(total);
      for (const m of members) expect(await statusOf(m.id)).toBe("active");
    },
  );

  it.each([1, 2])(
    "resolveContestedGroup: %i 番目（先頭でない）のメンバーのイベントが別テナントを指しても断る。何も書かない",
    async (position) => {
      const { store, make, ev, eventCount, statusOf } = setup();
      const b = await make(B);
      const members = [await make(A), await make(A), await make(A)];
      await store.markContestedGroup!(
        A,
        members.map((m) => ({ id: m.id, event: ev(m.id) })),
      );
      const total = store.events.length;
      const input = members.map((m, i) => ({
        id: m.id,
        status: i === 0 ? ("active" as const) : ("superseded" as const),
        ...(i === 0 ? {} : { supersededById: members[0]!.id }),
        event: ev(i === position ? b.id : m.id),
      }));

      await expect(store.resolveContestedGroup!(A, input)).rejects.toThrow(NOT_FOUND);

      expect(eventCount(b.id)).toBe(0);
      expect(store.events.length).toBe(total);
      for (const m of members) expect(await statusOf(m.id)).toBe("contested");
    },
  );
});
