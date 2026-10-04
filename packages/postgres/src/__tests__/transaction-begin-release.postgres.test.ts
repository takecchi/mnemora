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
  /** cause の連鎖のどこかに、接続が切られた印（SQLSTATE `57P01`、または pg の切断の文面）があるか。 */
  const isTerminatedConnectionError = (error: unknown): boolean => {
    let depth = 0;
    for (let e: unknown = error; e instanceof Error && depth < 5; e = e.cause, depth += 1) {
      if ((e as Error & { code?: unknown }).code === "57P01") return true;
      if (/terminating connection|Connection terminated/i.test(e.message)) return true;
    }
    return false;
  };

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

  it("release のあと、差し替えた query は接続に残らない（次の貸し出しへ持ち越して、古い transaction の記録を引きずらない）", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 1,
      application_name: "bg1-query-reset",
      onPoolError: () => {},
    });
    try {
      const raw = (client.db as typeof client.db & { $client: Pool }).$client;
      const first: PoolClient = await raw.connect();
      expect(Object.hasOwn(first, "query")).toBe(true);
      const prototypeQuery = Object.getPrototypeOf(first).query;
      first.release();
      expect(Object.hasOwn(first, "query")).toBe(false);
      expect(first.query).toBe(prototypeQuery);
      // 同じ物理接続を借り直しても、包みが二重に積まれない。
      const second: PoolClient = await raw.connect();
      expect(second).toBe(first);
      second.release();
      expect(Object.hasOwn(second, "query")).toBe(false);
    } finally {
      await closeWithin(client);
    }
  });

  it("捨てる接続（release(err)）には error リスナーを残し、返す接続（release()）からは外す", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: "bg1-listener-on-discard",
      onPoolError: () => {},
    });
    try {
      const raw = (client.db as typeof client.db & { $client: Pool }).$client;
      const returned: PoolClient = await raw.connect();
      // 借りている間に付いている error リスナー（mnemora の何もしないリスナーを含む）。
      const returnedWhileBorrowed = returned.listeners("error");
      expect(returnedWhileBorrowed.length).toBeGreaterThan(0);
      returned.release();
      // 返したあとは、借りている間のリスナーは1つも残らない（pool 自身の待機用リスナーに替わる）。
      expect(returned.listeners("error").some((l) => returnedWhileBorrowed.includes(l))).toBe(
        false,
      );

      const doomed: PoolClient = await raw.connect();
      const doomedWhileBorrowed = doomed.listeners("error");
      expect(doomedWhileBorrowed.length).toBeGreaterThan(0);
      doomed.release(new Error("捨てる"));
      // 捨てたあとに届く切断の error を受ける者が残っている（無ければ process が落ちる）。
      expect(doomed.listeners("error").some((l) => doomedWhileBorrowed.includes(l))).toBe(true);
    } finally {
      await closeWithin(client);
    }
  });

  /** backend の pid が `pg_stat_activity` に在るか。切った直後は消えるまで少しかかるので、消えるのを最大 2 秒待つ。 */
  const backendGone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40; i += 1) {
      const { rows } = await admin.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [
        pid,
      ]);
      if (rows.length === 0) return true;
      await sleep(50);
    }
    return false;
  };

  it("生きた接続に release(err) すると pool へ戻らず捨てられる（release() では pool に残る）", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: "bg1-discard",
      onPoolError: () => {},
    });
    try {
      const raw = (client.db as typeof client.db & { $client: Pool }).$client;
      const pidOf = async (c: PoolClient): Promise<number> => {
        const { rows } = await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        return rows[0]!.pid;
      };

      // 対照: 普通に返した接続は、pool の待機に残り、backend も生きている。
      const kept: PoolClient = await raw.connect();
      const keptPid = await pidOf(kept);
      expect(client.pool.totalCount).toBe(1);
      kept.release();
      expect(client.pool.totalCount).toBe(1);
      expect(client.pool.idleCount).toBe(1);
      expect(await backendGone(keptPid)).toBe(false);

      // 同じ接続を借り直して、今度は release(err) する。捨てられる。
      const doomed: PoolClient = await raw.connect();
      expect(await pidOf(doomed)).toBe(keptPid);
      doomed.release(new Error("捨てる"));
      expect(client.pool.totalCount).toBe(0);
      expect(client.pool.idleCount).toBe(0);
      expect(await backendGone(keptPid), "捨てた接続の backend が残っている").toBe(true);
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
      // ⚠ 最後の `pg_terminate_backend` は、pool で待機中の接続の backend も切る。pg-pool が待機中の接続の
      // 死に気づくのは socket のイベントが届いてからなので、直後に借りると死んだ接続を掴み、`begin` が
      // `57P01`（terminating connection due to administrator command）で落ちうる（ADR 0462。CI の UTF8・
      // SQL_ASCII の両方の脚で1回ずつ、手元の PostgreSQL 17 で 40 回中 3 回、この形で落ちた）。
      // 待機中の接続が死んでいることは使って初めて分かる（`packages/postgres/README.md` の「例外の見分け方」）。
      // ⟹ 死んだ待機中の接続は高々 `max`（3）本なので、切断の種類の失敗だけを `max` 回まで受け入れ、
      // そのたびに借りられたままが 0 に戻ること（BG-1）を確かめ、最後には新しい transaction が通ることを縛る。
      let terminatedFailures = 0;
      for (;;) {
        try {
          await client.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT 1`);
          });
          break;
        } catch (error) {
          if (!isTerminatedConnectionError(error) || terminatedFailures >= 3) throw error;
          terminatedFailures += 1;
          expect(checkedOut(client.pool), `切断の失敗 ${terminatedFailures} 回目の後`).toBe(0);
        }
      }
      expect(checkedOut(client.pool)).toBe(0);
    } finally {
      stop = true;
      await closeWithin(client);
    }
  }, 40_000);
});
