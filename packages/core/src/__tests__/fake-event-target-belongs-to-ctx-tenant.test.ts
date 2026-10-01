import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0469（ADR 0456 の H4・ADR 0466 の Fake 版）: core の `FakeMemoryStore` の書き込み口のうち、呼び出し側が
 * `NewMemoryEvent`（`memoryId` を持つ）を渡すものは、そのイベントが指す記憶が `ctx` のテナントの記憶であることを、
 * 書く前に確かめる。断るときは何も書かない（status の更新も、先に作った news も、イベントも残らない）。
 *
 * `@mnemora/postgres` の `PostgresMemoryStore`・testkit の `InMemoryMemoryStore` と同じ入力を同じように断る
 * （素の `Error`、message は `FakeMemoryStore: memory not found for tenant: <id>`。`kind`・`code` は無い）。
 * 大文字小文字は区別しない（Postgres は uuid を小文字にそろえて比べる）。
 *
 * この Fake は `createMemoriesWithOutboxAndEvents?` と `supersedeWithNewMemories` の `buildCreatedEvent` を実装していない
 * （任意のメソッド・任意の欄。core が別に `EventStore.append` で `created` を積む）ので、その2つはここに無い。
 *
 * 各 `it`: (1) 別テナントの記憶を指す `event.memoryId` は断られる。(2) 何も書かれない。
 * (3) やりすぎの対照: 自分の id・同じテナントの別の記憶・`null`・同じ呼び出しの別の行を指すイベントは通る。
 */

const A: Ctx = { tenantId: "fake-event-target-a" };
const B: Ctx = { tenantId: "fake-event-target-b" };
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
    contentHash: `fake-event-target-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-event-target" },
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
  const backing = (
    store as unknown as {
      backing: {
        events: Array<{ memoryId: string | null }>;
        memories: Map<string, { tenantId: string }>;
      };
    }
  ).backing;
  const memoryCount = (ctx: Ctx) =>
    [...backing.memories.values()].filter((m) => m.tenantId === ctx.tenantId).length;
  const make = (ctx: Ctx) => store.createMemory(ctx, newMemory(ctx));
  const ev = (memoryId: string | null): NewMemoryEvent => ({
    tenantId: "ignored",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: { probe: true },
  });
  const eventCount = (id: MemoryId) => backing.events.filter((e) => e.memoryId === id).length;
  const statusOf = async (ctx: Ctx, id: MemoryId) => (await store.get(ctx, id))?.status;
  return { store, backing, make, ev, eventCount, statusOf, memoryCount };
}

describe("event.memoryId が別テナントの記憶なら、書かずに断る（FakeMemoryStore）", () => {
  it("updateStatusWithEvent: status の更新ごと書かない。自分の id・同じテナントの別の記憶・null は通る", async () => {
    const { store, backing, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const a = await make(A);
    const total = backing.events.length;
    await expect(store.updateStatusWithEvent(A, a.id, "archived", {}, ev(b.id))).rejects.toThrow(
      NOT_FOUND,
    );
    expect(eventCount(b.id)).toBe(0);
    expect(backing.events.length).toBe(total);
    expect(await statusOf(A, a.id)).toBe("active");
    const other = await make(A);
    await store.updateStatusWithEvent(A, a.id, "archived", {}, ev(a.id));
    await store.updateStatusWithEvent(A, other.id, "archived", {}, ev(a.id));
    const third = await make(A);
    await store.updateStatusWithEvent(A, third.id, "archived", {}, ev(null));
    expect(backing.events.length).toBe(total + 3);
  });

  it("実在しない id・形式のおかしい id・空文字も、別テナントと同じ例外で断る（kind・code は無い）", async () => {
    const { store, make, ev, statusOf } = setup();
    const a = await make(A);
    for (const bad of ["not-a-uuid", "mem-does-not-exist", ""]) {
      const error = await store
        .updateStatusWithEvent(A, a.id, "archived", {}, ev(bad))
        .catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(NOT_FOUND);
      expect((error as Error).message).toContain(bad);
      expect((error as { code?: unknown }).code).toBeUndefined();
      expect((error as { kind?: unknown }).kind).toBeUndefined();
    }
    expect(await statusOf(A, a.id)).toBe("active");
  });

  it("大文字小文字は区別しない（Postgres は uuid を小文字にそろえる）。小文字の正規形で積む", async () => {
    const { store, backing, make, ev, eventCount } = setup();
    const a = await make(A);
    const other = await make(A);
    const b = await make(B);
    await store.updateStatusWithEvent(A, a.id, "archived", {}, ev(a.id.toUpperCase())); // 今更新した行
    await store.updateStatusWithEvent(A, other.id, "archived", {}, ev(a.id.toUpperCase())); // 同じテナントの別の記憶
    expect(eventCount(a.id)).toBe(2);
    expect(backing.events.some((e) => e.memoryId === a.id.toUpperCase())).toBe(false);
    // 別テナントの記憶は、大文字でも断る。
    const c = await make(A);
    await expect(
      store.updateStatusWithEvent(A, c.id, "archived", {}, ev(b.id.toUpperCase())),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
  });

  it("purgeMemory: 墓石も書かない", async () => {
    const { store, backing, make, ev, eventCount } = setup();
    const b = await make(B);
    const own = await make(A);
    await store.updateStatus(A, own.id, "forgotten");
    await store.purgeMemory!(A, own.id, { content: "[p]", digest: "[p]" }, ev(own.id));
    const a = await make(A);
    await store.updateStatus(A, a.id, "forgotten");
    const total = backing.events.length;
    await expect(
      store.purgeMemory!(A, a.id, { content: "[p]", digest: "[p]" }, ev(b.id)),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(backing.events.length).toBe(total);
    const after = await store.get(A, a.id);
    expect(after?.purgedAt ?? null).toBeNull();
    expect(after?.content).not.toBe("[p]");
  });

  it("markContestedPair・resolveContestedPair", async () => {
    const { store, backing, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [p1, p2] = [await make(A), await make(A)] as const;
    const total = backing.events.length;
    await expect(
      store.markContestedPair!(A, { id: p1.id, event: ev(b.id) }, { id: p2.id, event: ev(p2.id) }),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      store.markContestedPair!(A, { id: p1.id, event: ev(p1.id) }, { id: p2.id, event: ev(b.id) }),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(backing.events.length).toBe(total);
    expect(await statusOf(A, p1.id)).toBe("active");
    expect(await statusOf(A, p2.id)).toBe("active");
    await store.markContestedPair!(
      A,
      { id: p1.id, event: ev(p2.id) },
      { id: p2.id, event: ev(p1.id) },
    );
    expect(await statusOf(A, p1.id)).toBe("contested");
    await expect(
      store.resolveContestedPair!(
        A,
        { id: p1.id, status: "active", event: ev(b.id) },
        { id: p2.id, status: "superseded", supersededById: p1.id, event: ev(p2.id) },
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(await statusOf(A, p1.id)).toBe("contested");
    expect(await statusOf(A, p2.id)).toBe("contested");
    await store.resolveContestedPair!(
      A,
      { id: p1.id, status: "active", event: ev(p1.id) },
      { id: p2.id, status: "superseded", supersededById: p1.id, event: ev(null) },
    );
    expect(await statusOf(A, p2.id)).toBe("superseded");
  });

  it("resolveOrphanedContested", async () => {
    const { store, backing, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [z1, z2] = [await make(A), await make(A)] as const;
    await store.markContestedPair!(
      A,
      { id: z1.id, event: ev(z1.id) },
      { id: z2.id, event: ev(z2.id) },
    );
    await store.updateStatus(A, z2.id, "forgotten");
    const total = backing.events.length;
    await expect(
      store.resolveOrphanedContested!(A, { id: z1.id, contestedWithId: z2.id, event: ev(b.id) }),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(backing.events.length).toBe(total);
    expect(await statusOf(A, z1.id)).toBe("contested");
    await store.resolveOrphanedContested!(A, {
      id: z1.id,
      contestedWithId: z2.id,
      event: ev(z1.id),
    });
    expect(await statusOf(A, z1.id)).toBe("active");
  });

  it("markContestedGroup・resolveContestedGroup（群）", async () => {
    const { store, backing, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [g1, g2, g3] = [await make(A), await make(A), await make(A)] as const;
    const own = (id: MemoryId) => ({ id, event: ev(id) });
    const total = backing.events.length;
    await expect(
      store.markContestedGroup!(A, [{ id: g1.id, event: ev(b.id) }, own(g2.id), own(g3.id)]),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(backing.events.length).toBe(total);
    expect(await statusOf(A, g1.id)).toBe("active");
    await store.markContestedGroup!(A, [{ id: g1.id, event: ev(g2.id) }, own(g2.id), own(g3.id)]);
    expect(await statusOf(A, g1.id)).toBe("contested");
    await expect(
      store.resolveContestedGroup!(A, [
        { id: g1.id, status: "active", event: ev(b.id) },
        { id: g2.id, status: "superseded", supersededById: g1.id, event: ev(g2.id) },
        { id: g3.id, status: "superseded", supersededById: g1.id, event: ev(g3.id) },
      ]),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(await statusOf(A, g1.id)).toBe("contested");
    expect(await statusOf(A, g2.id)).toBe("contested");
  });

  it("markContestedGroup: 状態が変わらないメンバー（既に contested で相手なし）のイベントは積まないので、検査もしない（Postgres・InMemory と同じ）", async () => {
    const { store, make, ev, eventCount } = setup();
    const b = await make(B);
    const [g1, g2, g3, g4] = [await make(A), await make(A), await make(A), await make(A)] as const;
    const own = (id: MemoryId) => ({ id, event: ev(id) });
    await store.markContestedGroup!(A, [own(g1.id), own(g2.id), own(g3.id)]);
    const result = await store.markContestedGroup!(A, [
      { id: g1.id, event: ev(b.id) },
      own(g2.id),
      own(g4.id),
    ]);
    expect(result.events).toHaveLength(1); // g4 だけが active -> contested
    expect(eventCount(b.id)).toBe(0);
  });

  it("supersedeWithNewMemories: supersede の event。news も書かない", async () => {
    const { store, backing, make, ev, eventCount, statusOf, memoryCount } = setup();
    const b = await make(B);
    const old = await make(A);
    const total = backing.events.length;
    const memoriesBefore = memoryCount(A);
    await expect(
      store.supersedeWithNewMemories!(
        A,
        [{ input: newMemory(A), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: ev(b.id) }],
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(await statusOf(A, old.id)).toBe("active");
    expect(memoryCount(A)).toBe(memoriesBefore);
    expect(eventCount(b.id)).toBe(0);
    expect(backing.events.length).toBe(total);
    const ok = await store.supersedeWithNewMemories!(
      A,
      [{ input: newMemory(A), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, event: ev(old.id) }],
    );
    expect(ok.created).toHaveLength(1);
    expect(await statusOf(A, old.id)).toBe("superseded");
  });

  it("supersedeWithNewMemories: CAS に弾かれる対象のイベントは積まないので、検査もしない（Postgres・InMemory と同じ）", async () => {
    const { store, make, ev, eventCount } = setup();
    const b = await make(B);
    const old = await make(A);
    const result = await store.supersedeWithNewMemories!(
      A,
      [{ input: newMemory(A), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, expectedStatus: "archived", event: ev(b.id) }],
    );
    expect(result.conflicted).toHaveLength(1);
    expect(eventCount(b.id)).toBe(0);
  });

  // ADR 0475（ADR 0469 の続き）: `FakeEventStore.append` も、`event.memoryId` の大文字小文字を区別しない
  // （`PostgresEventStore.append` は uuid を小文字にそろえて通す）。断るときの message は渡された id のまま。
  it("FakeEventStore.append: 大文字の自テナントの記憶は通り（小文字で積む）、大文字の別テナントは断る。null は検査しない", async () => {
    const stores = createFakeRuntimeStores();
    const a = await stores.memoryStore.createMemory(A, newMemory(A));
    const b = await stores.memoryStore.createMemory(B, newMemory(B));
    const base = {
      tenantId: "ignored",
      kind: "updated" as const,
      actor: { type: "system" as const },
      meta: {},
    };
    const lower = await stores.eventStore.append(A, { ...base, memoryId: a.id });
    const upper = await stores.eventStore.append(A, { ...base, memoryId: a.id.toUpperCase() });
    expect(lower.memoryId).toBe(a.id);
    expect(upper.memoryId).toBe(a.id);
    expect(stores.eventStore.events.some((e) => e.memoryId === a.id.toUpperCase())).toBe(false);
    const total = stores.eventStore.events.length;
    for (const target of [b.id, b.id.toUpperCase(), "NOT-A-MEMORY", ""]) {
      const error = await stores.eventStore
        .append(A, { ...base, memoryId: target })
        .catch((e: unknown) => e as Error);
      expect((error as Error).message).toBe(
        `FakeEventStore: memory not found for tenant: ${target}`,
      );
    }
    expect(stores.eventStore.events.length).toBe(total);
    await stores.eventStore.append(A, { ...base, kind: "events_purged", memoryId: null });
    expect(stores.eventStore.events.length).toBe(total + 1);
  });
});
