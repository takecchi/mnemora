import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
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
 * 適合テストの歯は単一接続・逐次実行の範囲でしか見られず、in-memory 実装はトランザクションを模していないので、`db.transaction()` が本物の BEGIN/COMMIT/ROLLBACK として機能しているか
 * （同一行を奪い合う複数の実際に別のセッションの下でも、status の更新とイベントの追記が原子的であり続けるか）を、別々の `Pool` を N 本立てて検査する。
 * 検査する不変条件: ちょうど1本だけ成功し、`memories.status` が1回だけ書き換わり、`memory_events` に `superseded` イベントがちょうど1件だけ残る。残り3本は `MemoryStatusConflictError` になり、イベントが1件も増えない。
 */
describe("PostgresMemoryStore.updateStatusWithEvent を本物の並行・本物のトランザクションで検査する", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
    await closeTestClient();
  });

  it("同じ1行に4本が同時に expectedStatus:'active' で updateStatusWithEvent を撃つと、ちょうど1本だけ成功し、memory_events にちょうど1件だけ superseded が残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };
    const memory = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1" }),
    );
    expect(memory.status).toBe("active");
    // 自己置換は断られるので、置き換えた側は別の記憶にする。
    const winner = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "superseding-winner" }),
    );

    // 4本の「プロセス」相当。同一 Pool を共有しない。
    const N = 4;
    const clients = Array.from({ length: N }, () => createPostgresClient(requireDatabaseUrl()));
    pools.push(...clients);
    const stores = clients.map((client) => new PostgresMemoryStore(client.db));

    const results = await Promise.allSettled(
      stores.map((store) =>
        store.updateStatusWithEvent(
          ctx,
          memory.id,
          "superseded",
          { supersededById: winner.id, expectedStatus: "active" },
          {
            tenantId: ctx.tenantId,
            memoryId: memory.id,
            kind: "superseded",
            actor: { type: "system" },
            digestSnapshot: memory.digest,
            sizeBeforeBytes: null,
            meta: { reason: "concurrency-test" },
          },
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(MemoryStatusConflictError);
      expect((reason as MemoryStatusConflictError).memoryId).toBe(memory.id);
    }

    const final = await seedStore.get(ctx, memory.id);
    expect(final?.status).toBe("superseded");

    const events = await db.execute(sql`
      SELECT * FROM memory_events
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memory.id} AND kind = 'superseded'
    `);
    expect(events.rows).toHaveLength(1);
  }, 20_000);

  it("CAS に弾かれた1本のトランザクションでは、status も memory_events も一切変わらない（単一接続・逐次で厳密に確認する）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
    // 現在の status を archived にしておき、期待する expectedStatus: 'active' と食い違わせる。
    await store.updateStatus(ctx, memory.id, "archived");
    // 自己置換は断られるので、置き換えた側は別の記憶にする。
    const winner = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "superseding-winner" }),
    );

    await expect(
      store.updateStatusWithEvent(
        ctx,
        memory.id,
        "superseded",
        { expectedStatus: "active", supersededById: winner.id },
        {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "superseded",
          actor: { type: "system" },
          digestSnapshot: memory.digest,
          sizeBeforeBytes: null,
          meta: {},
        },
      ),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const unchanged = await store.get(ctx, memory.id);
    expect(unchanged?.status).toBe("archived");

    const events = await db.execute(sql`
      SELECT * FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memory.id}
    `);
    expect(events.rows).toHaveLength(0);
  });
});
