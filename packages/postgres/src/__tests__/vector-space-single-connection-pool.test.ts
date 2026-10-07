import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { embeddingSpaceIndexName, embeddingSpaceTableName } from "../embedding-space-table.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { dropTempDatabase } from "./temp-database.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * `registerEmbeddingSpace` は、`max: 1` の `Pool` でも止まらずに通る。
 *
 * advisory lock を握った接続を `pool.connect()` で借り切ったまま、DDL を `pool.query`
 * （別の接続が要る）で撃つと、`max: 1` ではその `pool.query` は借り切られた接続の返却を待ち、
 * 返却は `pool.query` の完了を待つので、誰も進めずに止まる（`lock_timeout` は advisory lock の
 * 待ちにしか効かず、Pool の待ちには効かない）。`connectionTimeoutMillis` を渡していないと、止まったまま返らない。
 * この歯は `connectionTimeoutMillis` を短く付けて、止まる形を「時間切れで落ちる」に変えて見る。
 */

const DATABASE = "mnemora_vs_single_connection";
const SPACE = { provider: "test", model: "vs-single-connection", dimensions: 4 };

let adminPool: Pool | undefined;
let pool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

describe("registerEmbeddingSpace を max: 1 の Pool で呼ぶ（ADR 0460）", () => {
  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    await dropTempDatabase(admin(), DATABASE);
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("max: 1 でも止まらずに通り、テーブルと索引が出来て、lock_timeout は元の値に戻る", async () => {
    await dropTempDatabase(admin(), DATABASE);
    await admin().query(`CREATE DATABASE ${DATABASE}`);
    // 利用者が接続側で lock_timeout を渡している形（README の「上限を付けるなら接続側で」）。
    pool = new Pool({
      connectionString: connectionStringFor(DATABASE),
      max: 1,
      connectionTimeoutMillis: 4000,
      options: "-c lock_timeout=7s",
    });
    await runMigrations(pool);

    const result = await registerEmbeddingSpace(pool, SPACE, { lockTimeoutMs: 2000 });
    expect(result.lock.waitedMs).toBeGreaterThanOrEqual(0);

    const table = embeddingSpaceTableName(SPACE);
    const index = embeddingSpaceIndexName(SPACE);
    const tables = await pool.query("SELECT 1 FROM pg_tables WHERE tablename = $1", [table]);
    const indexes = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [index]);
    expect(tables.rowCount).toBe(1);
    expect(indexes.rowCount).toBe(1);

    // 2回目（IF NOT EXISTS の経路）も通る。
    await registerEmbeddingSpace(pool, SPACE, { lockTimeoutMs: 2000 });

    // 戻す値の記録: 呼んだあとの接続（max: 1 なので同じ接続）の lock_timeout は、利用者が渡した値のまま。
    const shown = await pool.query<{ lock_timeout: string }>("SHOW lock_timeout");
    expect(shown.rows[0]?.lock_timeout).toBe("7s");
  }, 30_000);

  it("max: 2 でも、registerEmbeddingSpace・runMigrations のあと、どの接続の lock_timeout も利用者が渡した値のまま（0 に書き換えない）", async () => {
    const database = `${DATABASE}_restore`;
    await dropTempDatabase(admin(), database);
    await admin().query(`CREATE DATABASE ${database}`);
    const two = new Pool({
      connectionString: connectionStringFor(database),
      max: 2,
      options: "-c lock_timeout=7s",
    });
    try {
      await runMigrations(two);
      await registerEmbeddingSpace(two, { ...SPACE, model: "vs-restore" }, { lockTimeoutMs: 2000 });
      const clients = await Promise.all([two.connect(), two.connect()]);
      try {
        const values: string[] = [];
        for (const client of clients) {
          const shown = await client.query<{ lock_timeout: string }>("SHOW lock_timeout");
          values.push(shown.rows[0]?.lock_timeout ?? "(none)");
        }
        expect(values).toEqual(["7s", "7s"]);
      } finally {
        clients.forEach((client) => client.release());
      }
    } finally {
      await two.end();
      await dropTempDatabase(admin(), database);
    }
  }, 30_000);

  it("DDL の表ロック待ちは lockTimeoutMs に縛られない（lockTimeoutMs は advisory lock の待ちにだけ効く。ADR 0460）", async () => {
    const database = `${DATABASE}_ddl_wait`;
    await dropTempDatabase(admin(), database);
    await admin().query(`CREATE DATABASE ${database}`);
    const two = new Pool({ connectionString: connectionStringFor(database), max: 2 });
    const holder = new Pool({ connectionString: connectionStringFor(database), max: 1 });
    let held: PoolClient | undefined;
    try {
      await runMigrations(two);
      // memories を ACCESS EXCLUSIVE で握る。CREATE TABLE … REFERENCES memories は、これが外れるまで待つ。
      held = await holder.connect();
      await held.query("BEGIN");
      await held.query("LOCK TABLE memories IN ACCESS EXCLUSIVE MODE");
      const releaseAfterMs = 2500;
      const releaser = setTimeout(() => {
        void held?.query("COMMIT");
      }, releaseAfterMs);
      const startedAt = Date.now();
      try {
        // lockTimeoutMs は 1000。DDL の待ち（約 2.5 秒）が lockTimeoutMs に縛られるなら、55P03 で落ちる。
        await registerEmbeddingSpace(
          two,
          { ...SPACE, model: "vs-ddl-wait" },
          { lockTimeoutMs: 1000 },
        );
      } finally {
        clearTimeout(releaser);
      }
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(releaseAfterMs - 200);
    } finally {
      // 失敗した（待ちが縛られた）ときも、握りを必ず外してから pool を閉じる。
      await held?.query("COMMIT").catch(() => {});
      held?.release();
      await holder.end();
      await two.end();
      await dropTempDatabase(admin(), database);
    }
  }, 30_000);
});
