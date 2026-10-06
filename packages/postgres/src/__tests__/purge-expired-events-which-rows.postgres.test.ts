import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresMemoryStore.purgeExpiredEvents` は、同時に呼ばれても **`at` の古い順に `limit` 件**を消す。
 * 対象の SELECT は行を掴まない。別の接続が最古の行を掴んでいても、掃除は掴まれた行を選び、DELETE がそのロックを待つ。
 * 掴まれた行を飛ばして次の行を選ぶ形（`FOR UPDATE SKIP LOCKED`）は、件数は正しいまま、消える行が変わる。
 * そのため採らなかった（#1129 の PR 本文「どの行を消すか（古い順）は変えていない」）。
 *
 * 時間待ちで競わせず、順序は障壁で固定する（`purge-expired-events-by-retention-concurrency.postgres.test.ts` と同じ形）:
 * 1. 別の接続 A が、最古の3行を `SELECT ... FOR UPDATE` で掴んだまま保持する。
 * 2. その間に `purgeExpiredEvents`（limit 3）を起こす。`pg_stat_activity.wait_event_type = 'Lock'` で、掃除がロックを待っていることを確かめる。
 * 3. A を ROLLBACK する。掃除は最古の3行を消す。新しい3行は残る。
 *
 * `pg_stat_activity` を読むので、直列の群に置く（`vitest.config.mts` の `SERIAL_TEST_FILES`）。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const BARRIER_TIMEOUT_MS = 10_000;

function oldEvent(ctx: Ctx, at: Date): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId: null,
    kind: "created",
    at,
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  };
}

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
      throw new Error("障壁: 掃除が終わらず、行ロック待ちにも入らなかった");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("purgeExpiredEvents: 同時に呼ばれたとき、どの行を消すか（Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("最古の3行を別の接続が掴んでいる間は待たされ、解放されると、掴まれていた最古の3行を消す（掴まれていない次の3行を消さない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const eventStore = new PostgresEventStore(db);
    const ctx: Ctx = { tenantId: "purge-which-rows" };
    const base = NOW.getTime() - 100 * DAY_MS;
    const ats = Array.from({ length: 6 }, (_, i) => new Date(base + i * MINUTE_MS));
    for (const at of ats) {
      await eventStore.append(ctx, oldEvent(ctx, at));
    }

    let result: Awaited<ReturnType<typeof memoryStore.purgeExpiredEvents>> | undefined;
    let purgePromise: Promise<void> | undefined;
    let barrier: "done" | "lock_waiting" | undefined;

    class Release extends Error {}
    await db
      .transaction(async (tx) => {
        const { rows } = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
        const holderPid = (rows[0] as { pid: number }).pid;
        // A: 最古の3行を掴んだまま保持する。
        await tx.execute(sql`
          SELECT id FROM memory_events
          WHERE tenant_id = ${ctx.tenantId}
          ORDER BY at ASC LIMIT 3
          FOR UPDATE
        `);
        purgePromise = memoryStore
          .purgeExpiredEvents(ctx, { olderThan: NOW, limit: 3 })
          .then((r) => {
            result = r;
          });
        barrier = await waitUntilDoneOrLockWaiting(db, () => result !== undefined, holderPid);
        throw new Release();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Release)) throw e;
      });
    await purgePromise;

    expect(barrier).toBe("lock_waiting");
    expect(result).toEqual({
      purged: 3,
      reachedLimit: true,
      oldestPurgedAt: ats[0],
      newestPurgedAt: ats[2],
      dryRun: false,
    });
    const remaining = (await eventStore.list(ctx, {})).filter((e) => e.kind === "created");
    expect(remaining.map((e) => e.at)).toEqual(ats.slice(3));
  }, 30_000);
});
