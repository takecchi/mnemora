import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { sql } from "drizzle-orm";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const A: Ctx = { tenantId: "event-target-a" };
const B: Ctx = { tenantId: "event-target-b" };

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function setup() {
  const { db } = await getTestClient();
  const mem = new PostgresMemoryStore(db);
  let n = 0;
  const make = (ctx: Ctx) => {
    n += 1;
    return mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: `m${n}`,
        digest: `d${n}`,
        contentHash: `h-${ctx.tenantId}-${n}`,
      }),
    );
  };
  const ev = (memoryId: string, kind: "updated" | "created" = "updated"): NewMemoryEvent => ({
    tenantId: "ignored",
    memoryId,
    kind,
    actor: { type: "system" },
    meta: { probe: true },
  });
  const eventCount = async (id: MemoryId) =>
    Number(
      (await db.execute(sql`SELECT count(*)::int AS c FROM memory_events WHERE memory_id = ${id}`))
        .rows[0]!.c,
    );
  const statusOf = async (ctx: Ctx, id: MemoryId) => (await mem.get(ctx, id))?.status;
  return { mem, make, ev, eventCount, statusOf };
}

const NOT_FOUND = /memory not found for tenant/;

describe("event.memoryId が別テナントの記憶なら、書かずに断る", () => {
  it("updateStatusWithEvent: status の更新ごと戻る。自分の id は通る", async () => {
    const { mem, make, ev, eventCount, statusOf } = await setup();
    const b = await make(B);
    const own = await make(A);
    await mem.updateStatusWithEvent(A, own.id, "archived", {}, ev(own.id));
    const a = await make(A);
    await expect(mem.updateStatusWithEvent(A, a.id, "archived", {}, ev(b.id))).rejects.toThrow(
      NOT_FOUND,
    );
    expect(await eventCount(b.id)).toBe(0);
    expect(await statusOf(A, a.id)).toBe("active");
  });

  it("updateStatusWithEvent: uuid の形でない event.memoryId も、生の DB 例外でなく同じ例外になる", async () => {
    const { mem, make, ev } = await setup();
    const a = await make(A);
    const error = await mem
      .updateStatusWithEvent(A, a.id, "archived", {}, ev("not-a-uuid"))
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(NOT_FOUND);
    expect((error as Error).constructor.name).not.toBe("DrizzleQueryError");
    expect(await mem.get(A, a.id).then((m) => m?.status)).toBe("active");
  });

  it("purgeMemory", async () => {
    const { mem, make, ev, eventCount } = await setup();
    const b = await make(B);
    const own = await make(A);
    await mem.updateStatus(A, own.id, "forgotten");
    await mem.purgeMemory!(A, own.id, { content: "[p]", digest: "[p]" }, ev(own.id));
    const a = await make(A);
    await mem.updateStatus(A, a.id, "forgotten");
    await expect(
      mem.purgeMemory!(A, a.id, { content: "[p]", digest: "[p]" }, ev(b.id)),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
    expect((await mem.get(A, a.id))?.purgedAt ?? null).toBeNull();
  });

  it("markContestedPair・resolveContestedPair", async () => {
    const { mem, make, ev, eventCount, statusOf } = await setup();
    const b = await make(B);
    const [p1, p2] = [await make(A), await make(A)] as const;
    await expect(
      mem.markContestedPair!(A, { id: p1.id, event: ev(b.id) }, { id: p2.id, event: ev(p2.id) }),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
    expect(await statusOf(A, p1.id)).toBe("active");
    await mem.markContestedPair!(
      A,
      { id: p1.id, event: ev(p1.id) },
      { id: p2.id, event: ev(p2.id) },
    );
    await expect(
      mem.resolveContestedPair!(
        A,
        { id: p1.id, status: "active", event: ev(b.id) },
        { id: p2.id, status: "superseded", supersededById: p1.id, event: ev(p2.id) },
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
    expect(await statusOf(A, p1.id)).toBe("contested");
  });

  it("resolveOrphanedContested", async () => {
    const { mem, make, ev, eventCount, statusOf } = await setup();
    const b = await make(B);
    const [z1, z2] = [await make(A), await make(A)] as const;
    await mem.markContestedPair!(
      A,
      { id: z1.id, event: ev(z1.id) },
      { id: z2.id, event: ev(z2.id) },
    );
    await mem.updateStatus(A, z2.id, "forgotten");
    await expect(
      mem.resolveOrphanedContested!(A, { id: z1.id, contestedWithId: z2.id, event: ev(b.id) }),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
    expect(await statusOf(A, z1.id)).toBe("contested");
    await mem.resolveOrphanedContested!(A, { id: z1.id, contestedWithId: z2.id, event: ev(z1.id) });
    expect(await statusOf(A, z1.id)).toBe("active");
  });

  it("markContestedGroup・resolveContestedGroup（群の一括挿入）", async () => {
    const { mem, make, ev, eventCount, statusOf } = await setup();
    const b = await make(B);
    const [g1, g2, g3] = [await make(A), await make(A), await make(A)] as const;
    const own = (id: MemoryId) => ({ id, event: ev(id) });
    await expect(
      mem.markContestedGroup!(A, [{ id: g1.id, event: ev(b.id) }, own(g2.id), own(g3.id)]),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
    expect(await statusOf(A, g1.id)).toBe("active");
    await mem.markContestedGroup!(A, [own(g1.id), own(g2.id), own(g3.id)]);
    await expect(
      mem.resolveContestedGroup!(A, [
        { id: g1.id, status: "active", event: ev(b.id) },
        { id: g2.id, status: "superseded", supersededById: g1.id, event: ev(g2.id) },
        { id: g3.id, status: "superseded", supersededById: g1.id, event: ev(g3.id) },
      ]),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
    expect(await statusOf(A, g1.id)).toBe("contested");
  });

  it("supersedeWithNewMemories（supersede の event と buildCreatedEvent）・createMemoriesWithOutboxAndEvents", async () => {
    const { mem, make, ev, eventCount, statusOf } = await setup();
    const b = await make(B);
    const old = await make(A);
    const fresh = (name: string) =>
      buildNewMemoryFixture({
        tenantId: A.tenantId,
        content: name,
        digest: name,
        contentHash: `h-fresh-${name}`,
      });
    await expect(
      mem.supersedeWithNewMemories!(
        A,
        [{ input: fresh("s1"), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: ev(b.id) }],
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(await statusOf(A, old.id)).toBe("active");
    await expect(
      mem.supersedeWithNewMemories!(
        A,
        [{ input: fresh("s2"), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: ev(old.id) }],
        { buildCreatedEvent: () => ev(b.id, "created") },
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(await statusOf(A, old.id)).toBe("active");
    await expect(
      mem.createMemoriesWithOutboxAndEvents!(A, [{ input: fresh("c1"), jobKinds: [] }], () =>
        ev(b.id, "created"),
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
    const ok = await mem.createMemoriesWithOutboxAndEvents!(
      A,
      [{ input: fresh("c2"), jobKinds: [] }],
      (memory) => ev(memory.id, "created"),
    );
    expect(ok.written).toHaveLength(1);
    expect(await eventCount(ok.written[0]!.memory.id)).toBe(1);
  });

  // `checkedRef` が小文字にそろえて比べるので、大文字の uuid は自テナントの記憶として通り、uuid 列の正規形（小文字）で読み戻る。別テナントの記憶なら、大文字でも断る。
  it("event.memoryId が大文字の uuid でも、自テナントの記憶なら通り（小文字で読み戻る）、別テナントなら断る", async () => {
    const { mem, make, ev, eventCount } = await setup();
    const b = await make(B);
    const a = await make(A);
    const other = await make(A);
    await mem.updateStatusWithEvent(A, a.id, "archived", {}, ev(a.id.toUpperCase()));
    await mem.updateStatusWithEvent(A, other.id, "archived", {}, ev(a.id.toUpperCase()));
    expect(await eventCount(a.id)).toBe(2);
    const c = await make(A);
    await expect(
      mem.updateStatusWithEvent(A, c.id, "archived", {}, ev(b.id.toUpperCase())),
    ).rejects.toThrow(NOT_FOUND);
    expect(await eventCount(b.id)).toBe(0);
  });
});
