import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * `updateStatusWithEvent`（ADR 0031、PR「supersede-status-and-event-in-one-transaction」）を
 * **本物の Postgres トランザクション**で検査する。
 *
 * `packages/testkit/src/memory-store-conformance.ts` の `updateStatusWithEvent` の歯
 * （postgres 実装にも `conformance.postgres.test.ts` 経由で走る）は単一接続・逐次実行の
 * 範囲で「CAS に弾かれたら Memory もイベントも変わらない」ことを検査できる。しかし
 * それだけでは「`db.transaction()` が本物の BEGIN/COMMIT/ROLLBACK として機能しているか」
 * ——同一行を奪い合う複数の**実際に別の**セッションの下でも、
 * status の更新とイベントの追記が原子的であり続けるか——は確認できない
 * （in-memory 実装は元よりトランザクションを模していない）。
 *
 * `memory-store-update-status-concurrency.test.ts`（ADR 0030）と同じ構え——「別々の
 * `Pool` を N 本」立てる。同一 `Pool` を共有すると複数の論理的な「プロセス」を同じ
 * 接続の使い回しで模すことになり、本当に別セッションから同時に UPDATE が来た場合の
 * 競合（行ロックの奪い合い）を再現できない。
 *
 * 🔴 検査する不変条件: **ちょうど1本だけ成功し、`memories.status` が1回だけ書き換わり、
 * `memory_events` に `superseded` イベントがちょうど1件だけ残る。** 残り3本は
 * `MemoryStatusConflictError` になり、それぞれについてイベントが1件も増えていない。
 *
 * **⚠ これは CI（postgres ジョブ）でしか走らない。** この器には Docker/PostgreSQL/
 * `DATABASE_URL` が無く、手元では実行できていない（`requireDatabaseUrl()` が
 * `DATABASE_URL` 未設定で例外を投げ、テストランナー自体が起動しない）。
 */
describe("PostgresMemoryStore.updateStatusWithEvent を本物の並行・本物のトランザクションで検査する", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
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

    // 4本の「プロセス」相当。同一 Pool を共有しない理由は本ファイル冒頭のコメント参照。
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
          { supersededById: memory.id, expectedStatus: "active" },
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

    // ちょうど1本だけ成功。
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(MemoryStatusConflictError);
      expect((reason as MemoryStatusConflictError).memoryId).toBe(memory.id);
    }

    // 最終状態: superseded が1回分だけ適用されている（二重に上書きされていない）。
    const final = await seedStore.get(ctx, memory.id);
    expect(final?.status).toBe("superseded");

    // 🔴 本 PR の芯: status の更新と同じ回数だけイベントが残っている
    // ——3本が弾かれた分のイベントが漏れて積まれていないこと（原子性が本物の並行下でも
    // 保たれていること）を、実データを直接読んで確認する。
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

    await expect(
      store.updateStatusWithEvent(
        ctx,
        memory.id,
        "superseded",
        { expectedStatus: "active" },
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
