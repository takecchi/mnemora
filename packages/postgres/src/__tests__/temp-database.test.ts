import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "./test-db.js";
import { DatabaseDrainTimeoutError, dropTempDatabase } from "./temp-database.js";

/**
 * `dropTempDatabase`（ADR 0020）の歯。
 *
 * この歯が守っているもの: 「使い捨てデータベースを消すとき、接続が本当に0本に
 * なったことを実測してから DROP する」という主張そのもの。コメントで済ませず、
 * **決定的に**（時刻に依存せず）測る:
 *
 * - 正: 接続を自分できちんと閉じてから呼べば、例外なく DROP できる。
 * - 負（本命）: 接続を開いたまま呼べば、**必ず**（`WITH (FORCE)` へ黙って
 *   フォールバックせず）タイムアウトし、DB は生き残る。
 */

const DB_POSITIVE = "mnemora_temp_db_positive";
const DB_NEGATIVE = "mnemora_temp_db_negative";

let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function databaseExists(database: string): Promise<boolean> {
  const { rows } = await admin().query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [database],
  );
  return rows[0]?.exists ?? false;
}

describe("dropTempDatabase（ADR 0020: FORCE を使わず、接続0本を実測してから DROP する）", () => {
  afterAll(async () => {
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("正: pool.end() してから呼べば、例外なく DROP でき、DB が実際に消える", async () => {
    // 前の実行の残骸があっても構わないよう、まず掃除しておく。
    await dropTempDatabase(admin(), DB_POSITIVE);
    await admin().query(`CREATE DATABASE ${DB_POSITIVE}`);

    const pool = new Pool({ connectionString: connectionStringFor(DB_POSITIVE), max: 5 });
    // 実際に接続を張る（Pool は最初のクエリまで接続を確立しない）。
    await pool.query("SELECT 1");
    await pool.end();

    await expect(dropTempDatabase(admin(), DB_POSITIVE)).resolves.toBeUndefined();
    expect(await databaseExists(DB_POSITIVE)).toBe(false);
  }, 20_000);

  it("負（本命）: 接続を開いたままだと、必ずタイムアウトして例外を投げ、DB は生き残る", async () => {
    await dropTempDatabase(admin(), DB_NEGATIVE);
    await admin().query(`CREATE DATABASE ${DB_NEGATIVE}`);

    const pool = new Pool({ connectionString: connectionStringFor(DB_NEGATIVE), max: 5 });
    try {
      // わざと閉じないまま接続を張る（idle だが `pg_stat_activity` には残る接続）。
      await pool.query("SELECT 1");

      const drainTimeoutMs = 300;
      const error = await dropTempDatabase(admin(), DB_NEGATIVE, { drainTimeoutMs }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(DatabaseDrainTimeoutError);
      const drainError = error as DatabaseDrainTimeoutError;
      // メッセージに DB 名と、残っている接続の詳細（pid）が出ていること。
      expect(drainError.message).toContain(DB_NEGATIVE);
      expect(drainError.message).toMatch(/pid=\d+/);
      expect(drainError.remaining.length).toBeGreaterThan(0);

      // FORCE へ黙って落ちていない証拠: DB はまだ存在する。
      expect(await databaseExists(DB_NEGATIVE)).toBe(true);
    } finally {
      // 後始末: 接続を閉じてから、今度こそ FORCE 無しで消す。
      await pool.end();
      await dropTempDatabase(admin(), DB_NEGATIVE);
    }
  }, 20_000);
});
