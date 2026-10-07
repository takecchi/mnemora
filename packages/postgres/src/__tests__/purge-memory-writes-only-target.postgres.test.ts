import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "purge-target-only" };
const otherCtx: Ctx = { tenantId: "purge-target-only-other-tenant" };

async function purge(store: PostgresMemoryStore, id: MemoryId, tenant: Ctx = ctx) {
  return store.purgeMemory!(
    tenant,
    id,
    { content: "[purged]", digest: "[purged]" },
    {
      tenantId: tenant.tenantId,
      memoryId: id,
      kind: "purged",
      actor: { type: "system" },
      meta: {},
    },
  );
}

describe("PostgresMemoryStore.purgeMemory は対象の1件だけを書き換える", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("同じテナントの forgotten な別の記憶は、本文・要旨・purgedAt のどれも変わらず、purged イベントも積まれない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const target = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `t-${randomUUID()}`,
        status: "forgotten",
      }),
    );
    const bystander = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `b-${randomUUID()}`,
        status: "forgotten",
        content: "別の記憶の本文",
        digest: "別の記憶の要旨",
      }),
    );

    await purge(store, target.id);

    const after = await store.get(ctx, bystander.id);
    expect(after?.content).toBe("別の記憶の本文");
    expect(after?.digest).toBe("別の記憶の要旨");
    expect(after?.purgedAt ?? null).toBeNull();
    const events = await db.execute(
      sql`SELECT memory_id FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND kind = 'purged'`,
    );
    expect(events.rows.map((row) => (row as { memory_id: string }).memory_id)).toEqual([target.id]);
  });

  it("別のテナントの forgotten な記憶には、自分のテナントの purge でも、他方のテナントの ctx から同じ id を渡しても触れない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const target = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `t-${randomUUID()}`,
        status: "forgotten",
      }),
    );
    const otherTenant = await store.createMemory(
      otherCtx,
      buildNewMemoryFixture({
        tenantId: otherCtx.tenantId,
        contentHash: `o-${randomUUID()}`,
        status: "forgotten",
        content: "他のテナントの本文",
      }),
    );

    await purge(store, target.id);
    await expect(purge(store, target.id, otherCtx)).rejects.toThrow();

    const after = await store.get(otherCtx, otherTenant.id);
    expect(after?.content).toBe("他のテナントの本文");
    expect(after?.purgedAt ?? null).toBeNull();
  });

  it("purged イベントは渡した actor・meta・要旨（上書き前）をそのまま持つ", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const target = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `t-${randomUUID()}`,
        status: "forgotten",
        digest: "上書き前の要旨",
      }),
    );

    await store.purgeMemory!(
      ctx,
      target.id,
      { content: "[purged]", digest: "[purged]" },
      {
        tenantId: ctx.tenantId,
        memoryId: target.id,
        kind: "purged",
        actor: { type: "human", id: "alice" },
        digestSnapshot: "上書き前の要旨",
        meta: { reason: "法的要求" },
      },
    );

    const events = await db.execute(
      sql`SELECT actor, digest_snapshot, meta FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND kind = 'purged'`,
    );
    expect(events.rows).toEqual([
      {
        actor: { type: "human", id: "alice" },
        digest_snapshot: "上書き前の要旨",
        meta: { reason: "法的要求" },
      },
    ]);
  });
});
