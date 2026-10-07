import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function event(memoryId: string, overrides: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "contested_resolved", resolution: "orphan_reclaimed" },
    ...overrides,
  };
}

async function createOrphanedPair(store: InMemoryMemoryStore) {
  const a = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ contentHash: "orphaned-a", digest: "A" }),
  );
  const b = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ contentHash: "orphaned-b", digest: "B" }),
  );
  await store.markContestedPair(
    ctx,
    { id: a.id, event: event(a.id) },
    { id: b.id, event: event(b.id) },
  );
  await store.updateStatusWithEvent(ctx, b.id, "forgotten", {}, event(b.id, { kind: "forgotten" }));
  return { a, b };
}

describe("InMemoryMemoryStore.resolveOrphanedContested（Issue #825）", () => {
  it("CAS を満たせば生存側を active に戻し、contestedWithId を null にする。対向（forgotten）には触れない", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await createOrphanedPair(store);

    const result = await store.resolveOrphanedContested!(ctx, {
      id: a.id,
      contestedWithId: b.id,
      event: event(a.id),
    });

    expect(result.memory.status).toBe("active");
    expect(result.memory.contestedWithId).toBeNull();
    expect(result.event.kind).toBe("updated");

    const storedA = await store.get(ctx, a.id);
    expect(storedA?.status).toBe("active");
    expect(storedA?.contestedWithId).toBeNull();

    const storedB = await store.get(ctx, b.id);
    expect(storedB?.status).toBe("forgotten");
    expect(storedB?.contestedWithId).toBe(a.id);
  });

  it("id が存在しなければ「memory not found」を投げ、何も書き込まない", async () => {
    const store = new InMemoryMemoryStore();
    const { b } = await createOrphanedPair(store);

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: "does-not-exist",
        contestedWithId: b.id,
        event: event("does-not-exist"),
      }),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("CAS 破れ（status が contested でない）: MemoryStatusConflictError を投げ、行は無傷", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await createOrphanedPair(store);
    await store.updateStatusWithEvent(
      ctx,
      a.id,
      "forgotten",
      {},
      event(a.id, { kind: "forgotten" }),
    );

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: event(a.id),
      }),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const storedA = await store.get(ctx, a.id);
    expect(storedA?.status).toBe("forgotten");
  });

  it("CAS 破れ（contestedWithId が一致しない）: MemoryStatusConflictError を投げ、行は無傷", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await createOrphanedPair(store);
    const other = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ contentHash: "orphaned-other", digest: "C" }),
    );

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: other.id,
        event: event(a.id),
      }),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const storedA = await store.get(ctx, a.id);
    expect(storedA?.status).toBe("contested");
    expect(storedA?.contestedWithId).toBe(b.id);
  });

  it("渡された event の kind・actor・digestSnapshot・meta をそのまま積む", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await createOrphanedPair(store);

    const { event: stored } = await store.resolveOrphanedContested!(ctx, {
      id: a.id,
      contestedWithId: b.id,
      event: event(a.id, {
        kind: "forgotten",
        actor: { type: "human", id: "u1" },
        digestSnapshot: "snap",
        meta: { custom: 1 },
      }),
    });

    expect(stored).toMatchObject({
      kind: "forgotten",
      actor: { type: "human", id: "u1" },
      digestSnapshot: "snap",
      meta: { custom: 1 },
    });
  });
});
