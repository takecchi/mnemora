import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * ADR 0339 が塞いだ穴（`pool.connect()` で借り切った checked-out client に `error`
 * リスナーが無いと、接続が外部要因で失われたときプロセス全体が uncaught exception で
 * 落ちる）は `migrate.ts`/`advisory-lock.ts` **自身**の `pool.connect()` 呼び出しに
 * 対策された。
 *
 * だが `db.transaction()`（drizzle-orm の `NodePgSession.transaction`、
 * `node_modules/drizzle-orm/node-postgres/session.js`）も**同じ形で**
 * `pool.connect()` を呼んでいる——`await this.client.connect()` で checked-out
 * client を借り、`finally` で `release()` するが、**`error` リスナーは一切付けない。**
 * `memory-store.ts`/`vector-store.ts`/`trigram-lexical-store.ts` の全ての
 * `db.transaction()` 呼び出しがこの経路を通る。
 *
 * この歯は `db.transaction()` を直接叩いて（`MemoryStore` 等を経由せず）、
 * トランザクション本体の実行中に接続を強制終了し、`db.transaction()` が返す
 * Promise が reject する（プロセスを落とさない）ことを確かめる。
 * `migrate-connection-loss.test.ts` と同じ `pg_terminate_backend` の手口を使う。
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
        "SELECT pid FROM pg_stat_activity WHERE query ILIKE $1 AND pid <> pg_backend_pid()",
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
