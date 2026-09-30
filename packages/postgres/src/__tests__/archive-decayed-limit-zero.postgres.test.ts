import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0432 AL-4: `archiveDecayed` の `reachedLimit` は、`limit: 0` のとき対象が0件でも
 * `true` になっていた（`archived.length === opts.limit`）。TSDoc は「対象が0件なら
 * `reachedLimit: false`」。`limit: 0` は断らない——`LIMIT 0` は何も掃かずに通る。
 * `*-conformance.ts` には足さず、Postgres 側のここと testkit の Fake 側の歯で縛る。
 */

const ctx: Ctx = { tenantId: "archive-decayed-limit-zero-tenant" };
const now = new Date("2026-06-01T00:00:00.000Z");

describe("archiveDecayed: limit が 0 のとき reachedLimit は false（ADR 0432 AL-4）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestClient();
  });

  it("limit=0 は対象が在っても何も掃かず、reachedLimit: false", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-zero" }),
    );

    const result = await store.archiveDecayed(ctx, { now, limit: 0 });

    expect(result).toEqual({ archived: [], reachedLimit: false });
    expect((await store.get(ctx, memory.id))?.status).toBe("active");
  });

  it("limit=0 で対象が0件でも reachedLimit: false", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const result = await store.archiveDecayed(ctx, { now, limit: 0 });
    expect(result).toEqual({ archived: [], reachedLimit: false });
  });

  it("対照: limit=1 で1件掃いたら reachedLimit: true", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-one" }),
    );
    const result = await store.archiveDecayed(ctx, { now, limit: 1 });
    expect(result.archived).toHaveLength(1);
    expect(result.reachedLimit).toBe(true);
  });
});
