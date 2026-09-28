import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * Issue #868: `createPostgresClient` は drizzle に、`connect` だけを包んだ Proxy を渡す。
 * `db-transaction-connection-loss.test.ts`（落ちないこと）と
 * `public-pool-connect-unwrapped.test.ts`（公開する pool は書き換えないこと）の隣で、
 * 残りの2点を縛る。
 *
 * - `db.$client`（公開の型 `Db` には載っていないが、drizzle が実行時に生やす欄）から見える面。
 *   同一性だけが変わり、それ以外は本物の pool に届く。
 * - 付けたリスナーが `release()` で外れること。外れないと、同じ物理接続を借り直すたびに積み上がる。
 */
describe("createPostgresClient: drizzle に渡す Proxy", () => {
  it("db.$client は instanceof Pool で、totalCount・on・end() が本物の pool に届く。ただし === pool ではない", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    // `Db`（公開の型）には `$client` が載っていない。drizzle が実行時に生やしている欄を見る。
    const $client = (client.db as typeof client.db & { $client: Pool }).$client;
    try {
      await client.db.execute(sql`SELECT 1`);
      expect($client).toBeInstanceOf(Pool);
      // 決めた振る舞い（CHANGELOG [1.1.0]）: 同一性は変わる。
      expect($client === client.pool).toBe(false);
      expect($client.totalCount).toBe(client.pool.totalCount);
      expect($client.totalCount).toBeGreaterThan(0);
      const noop = (): void => {};
      $client.on("error", noop);
      expect(client.pool.listenerCount("error")).toBe(1);
      $client.removeListener("error", noop);
      expect(client.pool.listenerCount("error")).toBe(0);
    } finally {
      await $client.end();
    }
    // `$client.end()` で本物の pool が閉じている（2回目は pg が reject する）。
    expect(client.pool.ended).toBe(true);
  });

  it("commit と rollback を繰り返しても、同じ物理接続に mnemora のリスナーが残らない", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    try {
      for (let i = 0; i < 15; i += 1) {
        await client.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT 1`);
        });
        await expect(
          client.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT 1`);
            throw new Error("rollback させる");
          }),
        ).rejects.toThrow("rollback させる");
      }
      expect(client.pool.totalCount).toBe(1);
      // max: 1 なので、ここで借りるのは上の30回と同じ物理接続である。
      const reused = await client.pool.connect();
      try {
        expect(reused.listenerCount("error")).toBe(0);
      } finally {
        reused.release();
      }
    } finally {
      await closePostgresClient(client);
    }
  });

  it("トランザクションの最中に接続が切れたあとも、次の db.transaction() は新しい接続で通る", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), { max: 2 });
    try {
      const transacting = client.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(5)`);
      });
      let pid: number | undefined;
      for (let attempt = 0; attempt < 100 && pid === undefined; attempt += 1) {
        const { rows } = await client.pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE query ILIKE '%pg_sleep(5)%' AND pid <> pg_backend_pid()",
        );
        pid = rows[0]?.pid;
        if (pid === undefined) await sleep(50);
      }
      expect(pid).toBeDefined();
      await client.pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await expect(transacting).rejects.toThrow();

      const value = await client.db.transaction(async (tx) => {
        const result = await tx.execute<{ one: number }>(sql`SELECT 1 AS one`);
        return result.rows[0]?.one;
      });
      expect(value).toBe(1);
    } finally {
      await closePostgresClient(client);
    }
  }, 20_000);
});
