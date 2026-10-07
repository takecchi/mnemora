import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { isMemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 同じ対を引数の順序だけ入れ替えて並行に呼ぶ（`markContestedPair(A, B)` と `markContestedPair(B, A)`）。
 * 行ロックを id 昇順で取らないと、片方が A→B、もう片方が B→A の順で掴み合い、40P01（`deadlock detected`）で片方が中断される。
 *
 * デッドロックは本質的にタイミング依存で、毎回再現することは保証しない。この歯が検査する不変条件は
 * 「エラーが起きるなら、その型は必ず {@link MemoryStatusConflictError} である（生の Postgres 例外・その他の型が漏れない）」ことであり、
 * 「デッドロックそのものを毎回再現できる」ことではない。
 */
describe("PostgresMemoryStore.markContestedPair / resolveContestedPair — 対を逆順で並行に呼んでも生の Postgres 例外が漏れない", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
    await closeTestClient();
  });

  function event(memoryId: MemoryId): NewMemoryEvent {
    return {
      tenantId: "tenant-1",
      memoryId,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: "digest",
      meta: {},
    };
  }

  it("markContestedPair(A,B) と markContestedPair(B,A) を反復して並行に呼んでも、失敗は必ず MemoryStatusConflictError であり、勝者はちょうど1本になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };

    const a = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "lock-order-a" }),
    );
    const b = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "lock-order-b" }),
    );

    const clientT1 = createPostgresClient(requireDatabaseUrl());
    const clientT2 = createPostgresClient(requireDatabaseUrl());
    pools.push(clientT1, clientT2);
    const storeT1 = new PostgresMemoryStore(clientT1.db);
    const storeT2 = new PostgresMemoryStore(clientT2.db);

    const ITERATIONS = 15;
    let successCount = 0;
    let conflictCount = 0;
    const unexpected: unknown[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      await db.execute(sql`
        UPDATE memories SET status = 'active', contested_with_id = NULL
        WHERE tenant_id = 'tenant-1' AND id = ANY(${sql.param([a.id, b.id])}::uuid[])
      `);

      const p1 = storeT1.markContestedPair!(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );
      const p2 = storeT2.markContestedPair!(
        ctx,
        { id: b.id, event: event(b.id) },
        { id: a.id, event: event(a.id) },
      );

      const results = await Promise.allSettled([p1, p2]);
      for (const r of results) {
        if (r.status === "fulfilled") {
          successCount++;
        } else if (isMemoryStatusConflictError(r.reason)) {
          conflictCount++;
        } else {
          unexpected.push(r.reason);
        }
      }
    }

    expect(unexpected).toEqual([]);
    expect(successCount).toBe(ITERATIONS);
    expect(conflictCount).toBe(ITERATIONS);
  }, 30_000);

  it("resolveContestedPair(A,B) と resolveContestedPair(B,A) を反復して並行に呼んでも、失敗は必ず MemoryStatusConflictError であり、勝者はちょうど1本になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };

    const a = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "resolve-lock-order-a" }),
    );
    const b = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "resolve-lock-order-b" }),
    );

    const clientT1 = createPostgresClient(requireDatabaseUrl());
    const clientT2 = createPostgresClient(requireDatabaseUrl());
    pools.push(clientT1, clientT2);
    const storeT1 = new PostgresMemoryStore(clientT1.db);
    const storeT2 = new PostgresMemoryStore(clientT2.db);

    const ITERATIONS = 15;
    let successCount = 0;
    let conflictCount = 0;
    const unexpected: unknown[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      await seedStore.markContestedPair!(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );

      const p1 = storeT1.resolveContestedPair!(
        ctx,
        { id: a.id, status: "active", event: event(a.id) },
        { id: b.id, status: "active", event: event(b.id) },
      );
      const p2 = storeT2.resolveContestedPair!(
        ctx,
        { id: b.id, status: "active", event: event(b.id) },
        { id: a.id, status: "active", event: event(a.id) },
      );

      const results = await Promise.allSettled([p1, p2]);
      for (const r of results) {
        if (r.status === "fulfilled") {
          successCount++;
        } else if (isMemoryStatusConflictError(r.reason)) {
          conflictCount++;
        } else {
          unexpected.push(r.reason);
        }
      }
    }

    expect(unexpected).toEqual([]);
    expect(successCount).toBe(ITERATIONS);
    expect(conflictCount).toBe(ITERATIONS);
  }, 30_000);
});
