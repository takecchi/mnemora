import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `archive-decayed-concurrency.postgres.test.ts` と同じ「順序は sleep ではなく障壁で固定する」形:
 * 1. 別の接続で `tenant_settings` の該当テナントの行を `UPDATE`（`event_retention_days = NULL`、「無期限」への変更）するトランザクション A を開き、commit せずに保持する。
 * 2. その間に `purgeExpiredEventsByRetention` を起こす（B）。B の内部の `SELECT event_retention_days ... FOR SHARE` は、A が持つ行ロックが外れるまで待たされるはずで、`pg_stat_activity.wait_event_type = 'Lock'` で確認する。
 * 3. B が行ロック待ちに入ったことを確認してから A を commit する。commit 後、B は「無期限」を見て `{ kind: "unlimited" }` を返し、1件も削除しない（古い30日を使って削除してしまわない）。
 */

const TENANT = "purge-by-retention-concurrency-tenant";
const ctx: Ctx = { tenantId: TENANT };
const NOW = new Date("2030-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const BARRIER_TIMEOUT_MS = 10_000;

async function waitUntilDoneOrLockWaiting(
  db: Db,
  isDone: () => boolean,
  selfPid: number,
): Promise<"done" | "lock_waiting"> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  for (;;) {
    if (isDone()) return "done";
    const { rows } = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> ${selfPid}
    `);
    if ((rows[0] as { n: number }).n > 0) return "lock_waiting";
    if (Date.now() >= deadline) {
      throw new Error("障壁: 呼び出し B が終わらず、行ロック待ちにも入らなかった");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("PostgresMemoryStore.purgeExpiredEventsByRetention — 保持期間の読みと削除の原子性", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("別の接続が tenant_settings の行を未commit で保持している間は待たされ、commit 後は最新の値（無期限）を見て1件も消さない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();

    const tenantSettingsStore = new PostgresTenantSettingsStore(db);
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 30 });

    const memoryStoreB = new PostgresMemoryStore(db);
    const eventStore = new PostgresEventStore(db);
    const memory = await memoryStoreB.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "purge-by-retention-concurrency",
        content: "本文",
      }),
    );
    const hundredDaysAgo = await eventStore.append(ctx, {
      tenantId: TENANT,
      memoryId: memory.id,
      kind: "updated",
      actor: { type: "system" },
      meta: {},
      at: new Date(NOW.getTime() - 100 * DAY),
    });

    let bResult:
      | Awaited<ReturnType<NonNullable<PostgresMemoryStore["purgeExpiredEventsByRetention"]>>>
      | undefined;
    let bPromise: Promise<void> | undefined;
    let barrier: "done" | "lock_waiting" | undefined;

    await db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
      const aPid = (rows[0] as { pid: number }).pid;

      await tx.execute(sql`
        UPDATE tenant_settings SET event_retention_days = NULL, updated_at = now()
        WHERE tenant_id = ${TENANT}
      `);

      bPromise = memoryStoreB.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 100 }).then(
        (r) => {
          bResult = r;
        },
      );
      barrier = await waitUntilDoneOrLockWaiting(db, () => bResult !== undefined, aPid);
    });
    await bPromise;

    expect(barrier).toBe("lock_waiting");
    expect(bResult).toEqual({ kind: "unlimited" });
    expect(await eventStore.get(ctx, hundredDaysAgo.id)).not.toBeNull();
  });
});
