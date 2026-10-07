import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { requireDatabaseUrl } from "./test-db.js";

describe("createPostgresClient: drizzle に渡す Proxy", () => {
  it("db.$client は instanceof Pool で、totalCount・on・end() が本物の pool に届く。ただし === pool ではない", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    // `Db`（公開の型）には `$client` が載っていない。drizzle が実行時に生やしている欄を見る。
    const $client = (client.db as typeof client.db & { $client: Pool }).$client;
    try {
      await client.db.execute(sql`SELECT 1`);
      expect($client).toBeInstanceOf(Pool);
      expect($client === client.pool).toBe(false);
      expect($client.totalCount).toBe(client.pool.totalCount);
      expect($client.totalCount).toBeGreaterThan(0);
      // ベースラインは0ではなく1——`createPostgresClient` が既定で付ける pool error リスナーが常に1本ある。
      const baseline = client.pool.listenerCount("error");
      expect(baseline).toBe(1);
      const noop = (): void => {};
      $client.on("error", noop);
      expect(client.pool.listenerCount("error")).toBe(baseline + 1);
      $client.removeListener("error", noop);
      expect(client.pool.listenerCount("error")).toBe(baseline);
    } finally {
      await $client.end();
    }
    expect(client.pool.ended).toBe(true);
  });

  it("db.$client のメソッドは本物の pool に束縛されて呼ばれる（this を返すメソッドは、Proxy ではなく client.pool を返す）", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    const $client = (client.db as typeof client.db & { $client: Pool }).$client;
    try {
      const returned = $client.setMaxListeners($client.getMaxListeners());

      expect(returned).toBe(client.pool);
    } finally {
      await closePostgresClient(client);
    }
  });

  it("db.$client.connect(callback) は包まれず本物の pool に渡る（callback が呼ばれ、借りた接続に mnemora のリスナーは付かない）。promise 形は付く", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    const $client = (client.db as typeof client.db & { $client: Pool }).$client;
    try {
      const viaCallback = await Promise.race([
        new Promise<PoolClient>((resolve, reject) => {
          $client.connect((error, borrowed) =>
            error !== undefined || borrowed === undefined
              ? reject(error ?? new Error("接続が無い"))
              : resolve(borrowed),
          );
        }),
        sleep(2000).then((): never => {
          throw new Error("callback 形の connect が callback を呼ばなかった");
        }),
      ]);
      const listenersViaCallback = viaCallback.listenerCount("error");
      viaCallback.release();

      const viaPromise = await $client.connect();
      const listenersViaPromise = viaPromise.listenerCount("error");
      viaPromise.release();

      expect({ listenersViaCallback, listenersViaPromise }).toEqual({
        listenersViaCallback: 0,
        listenersViaPromise: 1,
      });
    } finally {
      await closePostgresClient(client);
    }
  });

  it("借りた直後の同期の区間で接続に error が出ても、リスナーが付いていて投げない（付けるのが1 microtask 遅れる窓が無い）", async () => {
    const client = createPostgresClient(requireDatabaseUrl(), { max: 1, onPoolError: () => {} });
    const pool = client.pool as unknown as { connect: (...args: unknown[]) => unknown };
    const realConnect = pool.connect.bind(client.pool);
    const injected = new Error("INJECTED: 借りた直後の切断");
    const thrown: unknown[] = [];
    const emitAfterBorrow = (borrowed: PoolClient): void => {
      try {
        borrowed.emit("error", injected);
      } catch (error) {
        thrown.push(error);
      }
    };
    pool.connect = (...args: unknown[]) => {
      const callback = args[0];
      if (typeof callback === "function") {
        return realConnect(
          (error: Error | undefined, borrowed: PoolClient | undefined, done: unknown) => {
            callback(error, borrowed, done);
            if (borrowed !== undefined) emitAfterBorrow(borrowed);
          },
        );
      }
      const promise = realConnect() as Promise<PoolClient>;
      void promise.then(emitAfterBorrow);
      return promise;
    };
    try {
      await client.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });

      expect(thrown).toEqual([]);
    } finally {
      pool.connect = realConnect;
      await closePostgresClient(client);
    }
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
        // ⚠ state = 'active' に絞り、探す文字列は引数で渡す。idle の接続の `query` 欄には最後に打った
        // クエリが残るので、文字列を SQL に直に書くと、この探索自身の接続が他の探索に見つかりうる。
        const { rows } = await client.pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query ILIKE $1 AND pid <> pg_backend_pid()",
          ["%pg_sleep(5)%"],
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
