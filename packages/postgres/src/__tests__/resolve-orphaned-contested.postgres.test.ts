import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresMemoryStore.resolveOrphanedContested` を、本物の Postgres に対して実行する。
 *
 * `resolveContestedPair` の CAS はここでは測らない（`resolve-contested-pair-guard.test.ts`/`conformance.postgres.test.ts` の `resolveContestedPair` 節が既に測っている）。ここで測るのは新しい口だけである。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function event(memoryId: MemoryId, overrides: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
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

async function createOrphanedPair(store: PostgresMemoryStore) {
  const a = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "pg-orphaned-a", digest: "A" }),
  );
  const b = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "pg-orphaned-b", digest: "B" }),
  );
  await store.markContestedPair!(
    ctx,
    { id: a.id, event: event(a.id) },
    { id: b.id, event: event(b.id) },
  );
  await store.updateStatusWithEvent(ctx, b.id, "forgotten", {}, event(b.id, { kind: "forgotten" }));
  return { a: a.id, b: b.id };
}

describe("PostgresMemoryStore.resolveOrphanedContested — 本物の Postgres（Issue #825）", () => {
  it("CAS を満たせば1トランザクションで生存側を active + contestedWithId=null にし、memory_events へ1件だけ積む。対向（forgotten）の行・イベントは無傷", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const { a, b } = await createOrphanedPair(store);

    const before = await store.get(ctx, b);

    const result = await store.resolveOrphanedContested!(ctx, {
      id: a,
      contestedWithId: b,
      event: event(a),
    });

    expect(result.memory.status).toBe("active");
    expect(result.memory.contestedWithId).toBeNull();
    expect(result.event.kind).toBe("updated");
    expect(result.event.meta).toMatchObject({
      reason: "contested_resolved",
      resolution: "orphan_reclaimed",
    });

    const storedA = await store.get(ctx, a);
    expect(storedA?.status).toBe("active");
    expect(storedA?.contestedWithId).toBeNull();

    const storedB = await store.get(ctx, b);
    expect(storedB?.status).toBe("forgotten");
    expect(storedB?.contestedWithId).toBe(a);
    expect(storedB?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });

  it("survivor.id が存在しなければ「memory not found」を投げる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const { b } = await createOrphanedPair(store);

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: "00000000-0000-4000-8000-000000000000",
        contestedWithId: b,
        event: event("00000000-0000-4000-8000-000000000000"),
      }),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("CAS 破れ（生存側が既に active）: MemoryStatusConflictError を投げ、行を書き換えない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const { a, b } = await createOrphanedPair(store);
    // a 自身を先に別経路で active に戻し、TOCTOU 後の再実行を模す。`updateStatusWithEvent`
    // は `contestedWithId` に触れないため、a は「status=active・contestedWithId=b」という
    // 過渡的な行になる——`resolveOrphanedContested` の CAS がまさにこれを弾く対象。
    await store.updateStatusWithEvent(ctx, a, "active", { expectedStatus: "contested" }, event(a));

    await expect(
      store.resolveOrphanedContested!(ctx, { id: a, contestedWithId: b, event: event(a) }),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const storedA = await store.get(ctx, a);
    expect(storedA?.status).toBe("active");
    expect(storedA?.contestedWithId).toBe(b);
  });

  it("CAS 破れ（contestedWithId が一致しない）: MemoryStatusConflictError を投げ、行を書き換えない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const { a, b } = await createOrphanedPair(store);
    const other = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "pg-orphaned-other" }),
    );

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: a,
        contestedWithId: other.id,
        event: event(a),
      }),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const storedA = await store.get(ctx, a);
    expect(storedA?.status).toBe("contested");
    expect(storedA?.contestedWithId).toBe(b);
  });

  it("対向がまだ active（forget していない）でも、この口自身は対向の状態を検査しない——呼び出し側（Runtime）の適格性判定を信頼して書く", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "pg-still-active-a" }),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "pg-still-active-b" }),
    );
    await store.markContestedPair!(
      ctx,
      { id: a.id, event: event(a.id) },
      { id: b.id, event: event(b.id) },
    );

    // b はまだ contested のまま（forget していない）。それでもこの口は CAS（a.status === 'contested' かつ a.contestedWithId === b.id）さえ満たせば書く。
    // 「対向が forgotten か」の判定は Runtime.resolveOrphanedContested の責務であり、この口自身の契約には無い。
    const result = await store.resolveOrphanedContested!(ctx, {
      id: a.id,
      contestedWithId: b.id,
      event: event(a.id),
    });
    expect(result.memory.status).toBe("active");

    const storedB = await store.get(ctx, b.id);
    expect(storedB?.status).toBe("contested");
    expect(storedB?.contestedWithId).toBe(a.id);
  });

  it("渡された event の kind・actor・digestSnapshot・meta をそのまま積む", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const { a, b } = await createOrphanedPair(store);

    const { event: stored } = await store.resolveOrphanedContested!(ctx, {
      id: a,
      contestedWithId: b,
      event: event(a, {
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

  it("別テナントの行は、contestedWithId が実際の対向と一致していても「memory not found」で、その行は無傷", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const other: Ctx = { tenantId: "tenant-2" };
    const otherEvent = (memoryId: MemoryId): NewMemoryEvent => ({
      ...event(memoryId),
      tenantId: other.tenantId,
    });
    const x = await store.createMemory(
      other,
      buildNewMemoryFixture({ tenantId: other.tenantId, contentHash: "pg-xt-x" }),
    );
    const y = await store.createMemory(
      other,
      buildNewMemoryFixture({ tenantId: other.tenantId, contentHash: "pg-xt-y" }),
    );
    await store.markContestedPair!(
      other,
      { id: x.id, event: otherEvent(x.id) },
      { id: y.id, event: otherEvent(y.id) },
    );

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: x.id,
        contestedWithId: y.id,
        event: event(x.id),
      }),
    ).rejects.toThrow(/memory not found for tenant/);

    const stored = await store.get(other, x.id);
    expect(stored?.status).toBe("contested");
    expect(stored?.contestedWithId).toBe(y.id);
  });
});

afterAll(async () => {
  await closeTestClient();
});
