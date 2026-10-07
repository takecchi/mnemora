import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Postgres の `now()` はトランザクションの開始時刻でテストからは止められない。そこで、作成の後に `created_at` を SQL で十分に過去へ書き換えてから操作する
 * （`created_at = now()` が足されると、過去の値は残らない）。
 */

const ctx: Ctx = { tenantId: "created-at-after-archive-purge-tenant" };
const now = new Date("2026-06-01T00:00:00.000Z");
const PAST = new Date("2000-01-01T00:00:00.000Z");

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function backdate(id: MemoryId): Promise<void> {
  const { db } = await getTestClient();
  await db.execute(
    sql`UPDATE memories SET created_at = ${PAST.toISOString()}::timestamptz WHERE id = ${id}::uuid`,
  );
}

describe("Postgres: createdAt は archive・purge の後も作成時のまま（ADR 0596）", () => {
  it("archiveDecayed の後も、createdAt は書き戻した過去の値のまま（updatedAt は進む）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const created = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-created-archive" }),
    );
    await backdate(created.id);
    const before = (await store.get(ctx, created.id))!;
    expect(before.createdAt).toEqual(PAST);

    const result = await store.archiveDecayed(ctx, { now, limit: 10 });

    expect(result.archived.map((a) => a.memoryId)).toEqual([created.id]);
    const stored = (await store.get(ctx, created.id))!;
    expect(stored.status).toBe("archived");
    expect(stored.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    expect(stored.createdAt).toEqual(PAST);
  });

  it("purgeMemory の後も、createdAt は書き戻した過去の値のまま（purgedAt は event.at）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const created = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-created-purge" }),
    );
    await store.updateStatus(ctx, created.id, "forgotten");
    await backdate(created.id);
    expect((await store.get(ctx, created.id))!.createdAt).toEqual(PAST);
    const at = new Date("2020-01-01T00:00:00.000Z");
    const event = {
      memoryId: created.id,
      kind: "purged",
      at,
      actor: { type: "system" },
      meta: {},
    } as unknown as NewMemoryEvent;

    await store.purgeMemory(ctx, created.id, { content: "[purged]", digest: "[purged]" }, event);

    const stored = (await store.get(ctx, created.id))!;
    expect(stored.purgedAt).toEqual(at);
    expect(stored.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    expect(stored.createdAt).toEqual(PAST);
  });
});
