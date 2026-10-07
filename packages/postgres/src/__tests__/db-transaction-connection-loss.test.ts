import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * `db.transaction()`（drizzle-orm の `NodePgSession.transaction`）は `pool.connect()` で借りた client に `error` リスナーを付けないので、
 * 接続が外部要因で失われるとプロセス全体が uncaught exception で落ちうる。
 * `MemoryStore` 等を経由せず `db.transaction()` を直接叩き、実行中に `pg_terminate_backend` で接続を強制終了して、
 * 返る Promise が reject する（プロセスを落とさない）ことを確かめる。
 */
describe("db.transaction(): 接続が外部要因で失われたとき", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  async function waitForBackendRunning(
    pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: { pid: number }[] }> },
    likePattern: string,
  ): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await pool.query(
        // idle の接続にも最後のクエリが残るので、実行中のものだけに絞る。
        "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query ILIKE $1 AND pid <> pg_backend_pid()",
        [likePattern],
      );
      if (rows.length > 0) {
        return rows[0]!.pid;
      }
      await sleep(50);
    }
    throw new Error(`waitForBackendRunning: ${likePattern} に一致するバックエンドが現れなかった`);
  }

  it("トランザクション本体の実行中に接続が失われても、db.transaction() は例外で reject する（プロセスを落とさない）", async () => {
    const { pool, db } = await getTestClient();

    const transacting = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(5)`);
    });

    const pid = await waitForBackendRunning(pool, "%pg_sleep(5)%");
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);

    await expect(transacting).rejects.toThrow();
  }, 20_000);
});
