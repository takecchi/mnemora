import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * Issue #759（ADR 0183 が `markContestedPair` だけに絞って残した負債の解消）。
 * `packages/testkit` の `memory-store-conformance.ts` にある `resolveContestedPair` 節は、
 * すべて「1回の呼び出しが1つの対だけを動かす」単発の呼び出ししか検査しない。
 * この2本は、その節が構造的に踏めない2つの経路を、Postgres 実装に対してだけ追加で検査する。
 *
 * 1本目（範囲外の行）: `updateSide` の最終 `UPDATE` の `WHERE` は `tenant_id` と `id` で
 * 対象を絞っているが、それを「対象2件」より広く書いても、既存の適合テストは
 * どれも気づけない——どのテストも「対象2件だけ」を見て、対象外の別の contested 対が
 * 無傷かどうかを assert していないため。
 *
 * 2本目（並行）: `updateSide` の最終 `UPDATE` は
 * `WHERE ... AND status = 'contested' AND contested_with_id = ${oppositeId}` という CAS を
 * 持つが、`resolveContestedPair` は直前の事前検証（同じトランザクション内の `SELECT`）でも
 * 同じ内容を検査している。単発の呼び出ししかしない既存テストでは、事前検証が先に
 * 全部弾いてしまうため、この最終 `UPDATE` 側の CAS が単独で効く場面が一度も来ない。
 * `memory-store-update-status-concurrency.test.ts` と同じ構え（別々の `Pool` を複数本
 * 立てて本物の行ロック競合を起こす）を使うと、初めてこの CAS だけが効く場面を作れる。
 *
 * **⚠ これは CI（postgres ジョブ）でしか走らない。** `DATABASE_URL` が無い環境では
 * `requireDatabaseUrl()` が例外を投げ、テストランナー自体が起動しない。
 */

function event(
  tenantId: string,
  memoryId: MemoryId,
  kind: "updated" | "superseded",
): NewMemoryEvent {
  return {
    tenantId,
    memoryId,
    kind,
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "resolve-contested-pair-scope-and-concurrency-test" },
  };
}

async function createContestedPair(
  store: PostgresMemoryStore,
  ctx: Ctx,
  aContentHash: string,
  bContentHash: string,
): Promise<{ a: MemoryId; b: MemoryId }> {
  const a = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: aContentHash }),
  );
  const b = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: bContentHash }),
  );
  await store.markContestedPair!(
    ctx,
    { id: a.id, event: event(ctx.tenantId, a.id, "updated") },
    { id: b.id, event: event(ctx.tenantId, b.id, "updated") },
  );
  return { a: a.id, b: b.id };
}

describe("PostgresMemoryStore.resolveContestedPair — 適合テストが踏まない2つの経路（Issue #759）", () => {
  const extraPools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of extraPools) {
      await client.pool.end();
    }
  });

  it("対象外の別の contested 対は無傷のまま残る（対象2件だけを動かす）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };

    const target = await createContestedPair(store, ctx, "scope-target-a", "scope-target-b");
    const bystander = await createContestedPair(
      store,
      ctx,
      "scope-bystander-a",
      "scope-bystander-b",
    );

    await store.resolveContestedPair!(
      ctx,
      { id: target.a, status: "active", event: event(ctx.tenantId, target.a, "updated") },
      { id: target.b, status: "active", event: event(ctx.tenantId, target.b, "updated") },
    );

    const afterTargetA = await store.get(ctx, target.a);
    const afterTargetB = await store.get(ctx, target.b);
    expect(afterTargetA?.status).toBe("active");
    expect(afterTargetB?.status).toBe("active");

    const afterBystanderA = await store.get(ctx, bystander.a);
    const afterBystanderB = await store.get(ctx, bystander.b);
    expect(afterBystanderA?.status).toBe("contested");
    expect(afterBystanderA?.contestedWithId).toBe(bystander.b);
    expect(afterBystanderB?.status).toBe("contested");
    expect(afterBystanderB?.contestedWithId).toBe(bystander.a);
  });

  it("同じ contested 対に2本の resolveContestedPair が同時に来ると、ちょうど1本だけ成功し、もう1本は MemoryStatusConflictError になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };

    const { a, b } = await createContestedPair(seedStore, ctx, "concurrency-a", "concurrency-b");

    // 別々の Pool を2本（同一 Pool の使い回しでは本物のセッション競合を再現できない、
    // memory-store-update-status-concurrency.test.ts と同じ理由）。
    const clients = Array.from({ length: 2 }, () => createPostgresClient(requireDatabaseUrl()));
    extraPools.push(...clients);
    const stores = clients.map((client) => new PostgresMemoryStore(client.db));

    const results = await Promise.allSettled(
      stores.map((store) =>
        store.resolveContestedPair!(
          ctx,
          { id: a, status: "active", event: event(ctx.tenantId, a, "updated") },
          { id: b, status: "active", event: event(ctx.tenantId, b, "updated") },
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // 最終状態: ちょうど1回分だけ解決されている（二重に処理されていない）。
    const finalA = await seedStore.get(ctx, a);
    const finalB = await seedStore.get(ctx, b);
    expect(finalA?.status).toBe("active");
    expect(finalA?.contestedWithId).toBeNull();
    expect(finalB?.status).toBe("active");
    expect(finalB?.contestedWithId).toBeNull();

    const { db: verifyDb } = await getTestClient();
    const eventsA = await verifyDb.execute(
      sql`SELECT kind FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${a}`,
    );
    const eventsB = await verifyDb.execute(
      sql`SELECT kind FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${b}`,
    );
    // markContestedPair が積んだ1件 + resolve が積んだ1件 = 2件。二重成功していれば4件になる。
    expect(eventsA.rows).toHaveLength(2);
    expect(eventsB.rows).toHaveLength(2);
  }, 20_000);
});
