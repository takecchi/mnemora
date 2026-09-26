import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `MemoryStore.archiveDecayed` の契約「同じ範囲の掃引が**同時に**走っても、同じ行が二度
 * archived にならず、`archived` のイベントも1件だけである」（`@mnemora/core` の
 * interface の doc、ADR 0114 の 2026-09-27 追記）を、本物の Postgres で縛る歯。
 *
 * 根拠は `buildArchiveDecayedTargetSelect` の `FOR UPDATE SKIP LOCKED`——後から来た掃引は、
 * 先の掃引が行ロックを持っている行を飛ばす。行ロックを外すと、後の掃引の `UPDATE` は先の
 * 掃引の行ロックが外れるのを待ち、外れた後に同じ行をもう一度 archived にする
 * （`UPDATE ... FROM target WHERE m.id = t.id` は `status` を見直さない）。
 *
 * **順序は sleep ではなく障壁で固定する**:
 * 1. 掃引 A を明示的なトランザクションの中で走らせる——A が選んだ行の行ロックは、
 *    トランザクションを閉じるまで外れない。
 * 2. その間に、別の接続で掃引 B を起こす。
 * 3. B が「終わった」か「行ロック待ちに入った」（`pg_stat_activity.wait_event_type =
 *    'Lock'`）かのどちらかを確かめてから、A を commit する。どちらにも倒れないまま
 *    上限の時間が過ぎたら、歯そのものを失敗にする（黙って順序が崩れた測定をしない）。
 */

const TENANT = "archive-decayed-concurrency-tenant";
const ctx: Ctx = { tenantId: TENANT };
const NOW = new Date("2026-06-01T00:00:00.000Z");
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
      throw new Error("障壁: 掃引 B が終わらず、行ロック待ちにも入らなかった");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("PostgresMemoryStore.archiveDecayed — 同じ範囲の掃引を同時に走らせても二重に archived にしない", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("先の掃引が行ロックを持っている間に後の掃引が走っても、archived になるのは1回、イベントも1件", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const storeB = new PostgresMemoryStore(db);
    const decayed = await storeB.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "archive-concurrency-target",
        decayFloorAt: new Date(NOW.getTime() - 1),
      }),
    );

    let bResult: Awaited<ReturnType<PostgresMemoryStore["archiveDecayed"]>> | undefined;
    let bPromise: Promise<void> | undefined;
    let barrier: "done" | "lock_waiting" | undefined;

    const aResult = await db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
      const aPid = (rows[0] as { pid: number }).pid;
      const storeA = new PostgresMemoryStore(tx as unknown as Db);
      const result = await storeA.archiveDecayed(ctx, { now: NOW, limit: 10 });
      // A は行ロックを持ったまま（まだ commit していない）。ここで B を起こす。
      bPromise = storeB.archiveDecayed(ctx, { now: NOW, limit: 10 }).then((r) => {
        bResult = r;
      });
      barrier = await waitUntilDoneOrLockWaiting(db, () => bResult !== undefined, aPid);
      return result;
    });
    await bPromise;

    expect(barrier).toBeDefined();
    expect(aResult.archived.map((a) => a.memoryId)).toEqual([decayed.id]);
    expect(bResult?.archived).toEqual([]);
    const { rows } = await db.execute(sql`
      SELECT count(*)::int AS n FROM memory_events
      WHERE tenant_id = ${TENANT} AND memory_id = ${decayed.id} AND kind = 'archived'
    `);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
