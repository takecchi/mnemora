import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { killConnectionBeforeStatement } from "./pool-fault-injection.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * ADR 0444 BG-1: drizzle-orm 0.45.2 の `NodePgSession.transaction` は `begin` を `try`/`finally` の
 * **外**で実行するため、`begin` が reject すると借りた接続が pool へ戻らない（枠が漏れる）。
 * `createPostgresClient` が包んで、`begin` の失敗で `release(err)` する。
 *
 * 「借りられたまま」の数は `pool.totalCount - pool.idleCount`（待機していない接続の数）で読む。
 * 直す前の実装ではこれが 0 に戻らない。
 *
 * 直列の群に置く（`pg_terminate_backend` を使う。`vitest.config.mts` の `SERIAL_TEST_FILES`）。
 * 切るのは `application_name` が一致する接続だけである。
 */
describe("db.transaction(): begin が reject しても接続は pool へ戻る（BG-1）", () => {
  let admin: PostgresClient;
  beforeAll(() => {
    admin = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: "bg1-admin",
    });
  });
  afterAll(async () => {
    await closePostgresClient(admin);
  });

  /** 枠が漏れていると `pool.end()` は終わらない。赤いときに 30 秒待たないよう、待つのは 2 秒まで。 */
  const closeWithin = async (c: PostgresClient): Promise<void> => {
    await Promise.race([closePostgresClient(c), sleep(2000)]);
  };
  const checkedOut = (pool: Pool): number => pool.totalCount - pool.idleCount;

  it("begin の直前に接続を殺しても、借りられたままの接続は 0 になる（繰り返しても枯れない）", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: "bg1-begin-kill",
      onPoolError: () => {},
    });
    try {
      // max=2 で 6 回。漏れるなら 3 回目までに枯れる。
      for (let i = 0; i < 6; i += 1) {
        const restore = killConnectionBeforeStatement({
          admin: admin.pool,
          applicationName: "bg1-begin-kill",
          matches: (text) => /^\s*begin\b/i.test(text),
        });
        try {
          await expect(
            client.db.transaction(async (tx) => {
              await tx.execute(sql`SELECT 1`);
            }),
          ).rejects.toThrow();
        } finally {
          restore();
        }
        expect(checkedOut(client.pool), `${i + 1}回目の後`).toBe(0);
      }
      // 健全な接続で普通に通る。
      await client.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });
      expect(checkedOut(client.pool)).toBe(0);
    } finally {
      await closeWithin(client);
    }
  }, 30_000);

  it("release は冪等: begin の失敗で返した後にもう一度 release しても、pg-pool の二重 release の例外は出ない", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: "bg1-idempotent",
      onPoolError: () => {},
    });
    try {
      const raw = (client.db as typeof client.db & { $client: Pool }).$client;
      const borrowed: PoolClient = await raw.connect();
      borrowed.release(new Error("捨てる"));
      expect(() => borrowed.release()).not.toThrow();
      expect(() => borrowed.release(new Error("もう一度"))).not.toThrow();
      expect(checkedOut(client.pool)).toBe(0);
      // 健全なときも同じ: 2回目は何もしない。
      const healthy: PoolClient = await raw.connect();
      healthy.release();
      expect(() => healthy.release()).not.toThrow();
      expect(client.pool.idleCount).toBe(1);
    } finally {
      await closeWithin(client);
    }
  });

  it("begin の失敗で投げられるのは、begin 自身の失敗（二重 release の例外で置き換わらない）", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: "bg1-original",
      onPoolError: () => {},
    });
    const restore = killConnectionBeforeStatement({
      admin: admin.pool,
      applicationName: "bg1-original",
      matches: (text) => /^\s*begin\b/i.test(text),
    });
    try {
      const error: unknown = await client.db
        .transaction(async (tx) => {
          await tx.execute(sql`SELECT 1`);
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      // drizzle は失敗を `Failed query: begin` で包む。理由は cause の連鎖にある。
      const chain: string[] = [];
      for (let e: unknown = error; e instanceof Error && chain.length < 5; e = e.cause) {
        chain.push(e.message);
      }
      expect(chain.join(" <- ")).not.toMatch(/already been released/i);
      expect(chain.join(" <- ")).toMatch(/connection|terminat/i);
    } finally {
      restore();
      await closeWithin(client);
    }
  });

  /**
   * CI で回せる形の「再起動の反復」。`pg_ctl restart -m fast` は CI の service container の
   * 中で動く Postgres には届かない（テストのプロセスから PGDATA にも pg_ctl にも触れない。
   * 理由と、手元で `pg_ctl restart` を反復して確かめた記録は ADR 0444）ので、代わりに
   * `pg_terminate_backend` で**全接続を切る反復**を、書き込みの負荷の最中にかける。
   * 切れる位置は運任せだが、反復しても pool が枯れず、最後に借りられたままが 0 で、
   * 新しい transaction が通ることを縛る。
   */
  it("負荷の最中に全接続を切る反復をしても、pool は枯れない", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 3,
      application_name: "bg1-churn",
      onPoolError: () => {},
    });
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop) {
        try {
          await client.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT 1`);
          });
        } catch {
          // 切られた。続ける。
        }
        await sleep(1);
      }
    };
    try {
      const workers = [worker(), worker(), worker(), worker(), worker()];
      for (let cycle = 0; cycle < 25; cycle += 1) {
        await sleep(30);
        await admin.pool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
          ["bg1-churn"],
        );
      }
      stop = true;
      const finished = await Promise.race([
        Promise.all(workers).then(() => true),
        sleep(10_000).then(() => false),
      ]);
      expect(finished, "worker が終わらない（pool が枯れて待ち続けている）").toBe(true);
      expect(checkedOut(client.pool)).toBe(0);
      await client.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });
    } finally {
      stop = true;
      await closeWithin(client);
    }
  }, 40_000);
});
