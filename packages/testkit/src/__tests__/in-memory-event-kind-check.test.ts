import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { MemoryPurgeConflictError, MemoryStatusConflictError } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "event-kind-check" };

function eventWithKind(memoryId: string, kind: string): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: kind as NewMemoryEvent["kind"],
    actor: { type: "system" },
    meta: {},
  };
}

describe("testkit の fixture は MemoryEventKind に無い kind を拒む", () => {
  it("InMemoryEventStore.append は拒み、何も書かない（文面は at の検査と同じ形）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-append" }),
    );

    await expect(eventStore.append(ctx, eventWithKind(m.id, "contested"))).rejects.toThrow(
      /^memory_events\.kind must be one of created, updated, .* \(got "contested"\)$/,
    );
    expect(memoryStore.events).toHaveLength(0);
  });

  it("updateStatusWithEvent・markContestedPair は拒み、状態を変えない", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-a" }),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-b" }),
    );

    await expect(
      store.updateStatusWithEvent(
        ctx,
        a.id,
        "forgotten",
        { expectedStatus: "active" },
        eventWithKind(a.id, "deleted"),
      ),
    ).rejects.toThrow(/memory_events\.kind must be one of/);
    await expect(
      store.markContestedPair(
        ctx,
        { id: a.id, event: eventWithKind(a.id, "updated") },
        { id: b.id, event: eventWithKind(b.id, "contested") },
      ),
    ).rejects.toThrow(/memory_events\.kind must be one of/);

    expect((await store.get(ctx, a.id))?.status).toBe("active");
    expect((await store.get(ctx, b.id))?.status).toBe("active");
    expect(store.events).toHaveLength(0);
  });
});

describe("testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む", () => {
  const KIND_MESSAGE = /memory_events\.kind must be one of/;

  async function create(store: InMemoryMemoryStore, hash: string) {
    return store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: hash }),
    );
  }

  async function contestedPair(store: InMemoryMemoryStore, hash: string) {
    const a = await create(store, `${hash}-a`);
    const b = await create(store, `${hash}-b`);
    await store.markContestedPair(
      ctx,
      { id: a.id, event: eventWithKind(a.id, "updated") },
      { id: b.id, event: eventWithKind(b.id, "updated") },
    );
    return { a, b };
  }

  it("purgeMemory は拒み、墓石を書かない", async () => {
    const store = new InMemoryMemoryStore();
    const m = await create(store, "kind-purge");
    await store.updateStatus(ctx, m.id, "forgotten");
    const before = await store.get(ctx, m.id);
    await expect(
      store.purgeMemory(
        ctx,
        m.id,
        { content: "[purged]", digest: "[purged]" },
        eventWithKind(m.id, "bogus"),
      ),
    ).rejects.toThrow(KIND_MESSAGE);
    expect(await store.get(ctx, m.id)).toEqual(before);
    expect(store.events).toHaveLength(0);
  });

  it("resolveContestedPair は拒み、2件とも contested のまま、イベントも増えない", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await contestedPair(store, "kind-resolve");
    const eventsBefore = store.events.length;
    await expect(
      store.resolveContestedPair(
        ctx,
        { id: a.id, status: "active", event: eventWithKind(a.id, "updated") },
        {
          id: b.id,
          status: "superseded",
          supersededById: a.id,
          event: eventWithKind(b.id, "bogus"),
        },
      ),
    ).rejects.toThrow(KIND_MESSAGE);
    expect((await store.get(ctx, a.id))?.status).toBe("contested");
    expect((await store.get(ctx, b.id))?.status).toBe("contested");
    expect(store.events).toHaveLength(eventsBefore);
  });

  it("resolveOrphanedContested は拒み、contested のまま、イベントも増えない", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await contestedPair(store, "kind-orphan");
    const eventsBefore = store.events.length;
    await expect(
      store.resolveOrphanedContested(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: eventWithKind(a.id, "bogus"),
      }),
    ).rejects.toThrow(KIND_MESSAGE);
    expect((await store.get(ctx, a.id))?.status).toBe("contested");
    expect(store.events).toHaveLength(eventsBefore);
  });

  it("supersedeWithNewMemories は拒み、新しい行も outbox も書かず、supersede される側も変えない", async () => {
    const store = new InMemoryMemoryStore();
    const old = await create(store, "kind-supersede-old");
    await expect(
      store.supersedeWithNewMemories(
        ctx,
        [
          {
            input: buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-new" }),
            jobKinds: ["embed"],
          },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: eventWithKind(old.id, "bogus"),
          },
        ],
      ),
    ).rejects.toThrow(KIND_MESSAGE);
    expect((await store.get(ctx, old.id))?.status).toBe("active");
    expect(store.listByTenant(ctx)).toHaveLength(1);
    expect(store.outboxJobs).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });

  it("markContestedPair は、1件目のイベントが不正な kind でも拒み、状態を変えない", async () => {
    const store = new InMemoryMemoryStore();
    const a = await create(store, "kind-first-a");
    const b = await create(store, "kind-first-b");
    await expect(
      store.markContestedPair(
        ctx,
        { id: a.id, event: eventWithKind(a.id, "contested") },
        { id: b.id, event: eventWithKind(b.id, "updated") },
      ),
    ).rejects.toThrow(KIND_MESSAGE);
    expect((await store.get(ctx, a.id))?.status).toBe("active");
    expect((await store.get(ctx, b.id))?.status).toBe("active");
    expect(store.events).toHaveLength(0);
  });

  describe("不正な kind が、見つからない id・CAS の食い違いと重なったときは、そちらが先に決まる（Postgres は更新する行が無ければ CHECK に届かない）", () => {
    it("updateStatusWithEvent", async () => {
      const store = new InMemoryMemoryStore();
      const m = await create(store, "order-update");
      await expect(
        store.updateStatusWithEvent(
          ctx,
          "mem-missing",
          "forgotten",
          {},
          eventWithKind("mem-missing", "bogus"),
        ),
      ).rejects.toThrow(/memory not found/);
      await expect(
        store.updateStatusWithEvent(
          ctx,
          m.id,
          "forgotten",
          { expectedStatus: "archived" },
          eventWithKind(m.id, "bogus"),
        ),
      ).rejects.toThrow(MemoryStatusConflictError);
    });

    it("purgeMemory", async () => {
      const store = new InMemoryMemoryStore();
      const m = await create(store, "order-purge");
      const tombstone = { content: "[purged]", digest: "[purged]" };
      await expect(
        store.purgeMemory(ctx, "mem-missing", tombstone, eventWithKind("mem-missing", "bogus")),
      ).rejects.toThrow(/memory not found/);
      await expect(
        store.purgeMemory(ctx, m.id, tombstone, eventWithKind(m.id, "bogus")),
      ).rejects.toThrow(MemoryPurgeConflictError);
    });

    it("markContestedPair", async () => {
      const store = new InMemoryMemoryStore();
      const a = await create(store, "order-mark-a");
      const b = await create(store, "order-mark-b");
      await store.updateStatus(ctx, b.id, "forgotten");
      await expect(
        store.markContestedPair(
          ctx,
          { id: a.id, event: eventWithKind(a.id, "bogus") },
          { id: "mem-missing", event: eventWithKind("mem-missing", "updated") },
        ),
      ).rejects.toThrow(/memory not found/);
      await expect(
        store.markContestedPair(
          ctx,
          { id: a.id, event: eventWithKind(a.id, "bogus") },
          { id: b.id, event: eventWithKind(b.id, "updated") },
        ),
      ).rejects.toThrow(MemoryStatusConflictError);
    });

    it("resolveContestedPair（status は列挙の中。status の検査が先に来る入力は使わない）", async () => {
      const store = new InMemoryMemoryStore();
      const a = await create(store, "order-resolve-a");
      const b = await create(store, "order-resolve-b");
      await expect(
        store.resolveContestedPair(
          ctx,
          { id: a.id, status: "active", event: eventWithKind(a.id, "bogus") },
          {
            id: "mem-missing",
            status: "superseded",
            supersededById: a.id,
            event: eventWithKind("mem-missing", "updated"),
          },
        ),
      ).rejects.toThrow(/memory not found/);
      await expect(
        store.resolveContestedPair(
          ctx,
          { id: a.id, status: "active", event: eventWithKind(a.id, "bogus") },
          {
            id: b.id,
            status: "superseded",
            supersededById: a.id,
            event: eventWithKind(b.id, "updated"),
          },
        ),
      ).rejects.toThrow(MemoryStatusConflictError);
    });

    it("resolveOrphanedContested", async () => {
      const store = new InMemoryMemoryStore();
      const m = await create(store, "order-orphan");
      await expect(
        store.resolveOrphanedContested(ctx, {
          id: "mem-missing",
          contestedWithId: m.id,
          event: eventWithKind("mem-missing", "bogus"),
        }),
      ).rejects.toThrow(/memory not found/);
      await expect(
        store.resolveOrphanedContested(ctx, {
          id: m.id,
          contestedWithId: "mem-other",
          event: eventWithKind(m.id, "bogus"),
        }),
      ).rejects.toThrow(MemoryStatusConflictError);
    });
  });
});
