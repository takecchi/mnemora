import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/** 期待値をハードコードせず、`listMigrationFiles(DEFAULT_MIGRATIONS_DIR)` から導出する。引き継いだ 0001 は再実行しないが、その後に増えたファイルは適用する、という区別が検査対象で、`NON_LEGACY_FILES` はそれを表す。 */
const ALL_MIGRATION_FILES = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
const NON_LEGACY_FILES = ALL_MIGRATION_FILES.filter((name) => name !== "0001_init.sql");

/**
 * まっさらな DB で migrate が通ることは、この引き継ぎを何も測っていない。引き継ぎが効くのは旧名の台帳が入った DB に対してだけなので、その旧い状態をこちらで作ってから測る。
 *
 * スキーマではなくテスト専用の「データベース」を作る。引き継ぎの判定の `to_regclass('_mnemora_migrations')` は `search_path` を辿って解決するので、共有 DB の中に専用スキーマを切る形では隔離できない
 * （CI は本番の台帳を `public` に作った状態でテストへ入るので、`public._mnemora_migrations` を拾って引き継ぎが起きない）。
 * かといって `search_path` から `public` を外すと、`0001_init.sql` の `CREATE INDEX ... USING gin (tenant_id, tags)` が `public` の btree_gin の operator class を解決できずに落ちる。
 * どちらにも倒れないので、テストごとに独立したデータベースを作って捨てる。前提: 接続ロールが `CREATE DATABASE` と `CREATE EXTENSION` を行えること。
 */

/** テストごとに作って捨てるデータベース。名前は固定にして、落ちた回の残骸も拾えるようにする。 */
const DB_NOT_REAPPLIED = "mnemora_ledger_handover_not_reapplied";
const DB_ROWS_CARRIED = "mnemora_ledger_handover_rows_carried";
const DB_BLANK = "mnemora_ledger_handover_blank";
const DB_BOTH_PRESENT = "mnemora_ledger_handover_both_present";

/** 台帳が「引き継がれた」のか「作り直された」のかを見分けるための目印。`0001_init.sql` の行だけでは、空の台帳を作って 0001 を適用し直した場合と区別できないので、実在しないマイグレーション名を1行混ぜておく。 */
const SENTINEL_ROW = "0000_row_that_only_a_handover_can_carry.sql";

/** 改名前のコードが作っていた台帳の DDL を、そのまま写したもの。意図的な複製である。改名前の DB がどうなっていたかは変わらない事実なので、`migrate.ts` の現在の定義を参照すると、検査対象を直したときに検査のほうも動いて、引き継ぎを測らなくなる。 */
const LEGACY_LEDGER_DDL = `
  CREATE TABLE _mnemo_migrations (
    name         text        PRIMARY KEY,
    applied_at   timestamptz NOT NULL DEFAULT now()
  );
`;

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
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

/** 空のデータベースを作り、そこへ向いた Pool を返す。データベース名はこのファイル内の定数だけなので、識別子をそのまま SQL へ埋めてよい（`CREATE DATABASE` の名前はパラメータ化できない）。 */
async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 2 });
  openedPools.push(pool);
  return pool;
}

/** 「改名前に作られ、`0001_init.sql` まで適用済みだった DB」を再現する。`runMigrations` は通さない。検査対象の側を通して旧い状態を作ると、引き継ぎが壊れたときに前提のほうも壊れて歯が空振りする。 */
async function seedLegacyDatabase(pool: Pool): Promise<void> {
  await pool.query(LEGACY_LEDGER_DDL);
  await pool.query(readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0001_init.sql"), "utf8"));
  await pool.query("INSERT INTO _mnemo_migrations (name) VALUES ($1)", ["0001_init.sql"]);
}

async function legacyLedgerExists(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('_mnemo_migrations') IS NOT NULL AS present",
  );
  return rows[0]!.present;
}

async function ledgerNames(pool: Pool, table: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM ${table} ORDER BY name ASC`,
  );
  return rows.map((row) => row.name);
}

describe("マイグレーション台帳の引き継ぎ（_mnemo_migrations → _mnemora_migrations）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("旧名の台帳が在る DB へ migrate しても 0001_init.sql は再実行されない", async () => {
    const pool = await createBlankDatabase(DB_NOT_REAPPLIED);
    await seedLegacyDatabase(pool);

    const first = await runMigrations(pool);
    expect(first.applied).not.toContain("0001_init.sql");
    expect(first.applied).toEqual(NON_LEGACY_FILES);

    await expect(runMigrations(pool)).resolves.toEqual({
      applied: [],
      lock: { waitedMs: expect.any(Number) },
    });
  });

  // 落ちないだけなら台帳を空にしても通ってしまうので、「行が引き継がれた」ことは独立に測る。
  it("旧名の台帳の行が、新名の台帳へそのまま引き継がれる（作り直されない）", async () => {
    const pool = await createBlankDatabase(DB_ROWS_CARRIED);
    await seedLegacyDatabase(pool);
    await pool.query("INSERT INTO _mnemo_migrations (name) VALUES ($1)", [SENTINEL_ROW]);

    const before = await pool.query<{ name: string; applied_at: Date }>(
      "SELECT name, applied_at FROM _mnemo_migrations ORDER BY name ASC",
    );
    expect(before.rows.map((row) => row.name)).toEqual([SENTINEL_ROW, "0001_init.sql"]);

    await runMigrations(pool);

    expect(await legacyLedgerExists(pool)).toBe(false);

    const after = await pool.query<{ name: string; applied_at: Date }>(
      "SELECT name, applied_at FROM _mnemora_migrations ORDER BY name ASC",
    );
    const carriedRows = after.rows.filter((row) =>
      before.rows.some((beforeRow) => beforeRow.name === row.name),
    );
    expect(carriedRows).toEqual(before.rows);
    expect(after.rows).toHaveLength(before.rows.length + NON_LEGACY_FILES.length);
  });

  it("まっさらな DB でも通る（旧名が無ければ引き継ぎは何もしない）", async () => {
    const pool = await createBlankDatabase(DB_BLANK);

    await expect(runMigrations(pool)).resolves.toEqual({
      applied: ALL_MIGRATION_FILES,
      lock: { waitedMs: expect.any(Number) },
    });
    expect(await ledgerNames(pool, "_mnemora_migrations")).toEqual(ALL_MIGRATION_FILES);
    expect(await legacyLedgerExists(pool)).toBe(false);

    await expect(runMigrations(pool)).resolves.toEqual({
      applied: [],
      lock: { waitedMs: expect.any(Number) },
    });
  });

  // 新旧どちらも在るときは触らない。ここで RENAME してしまうと、生きている台帳を古い台帳で上書きすることになる。
  it("新旧どちらの台帳も在るときは、引き継ぎは何もしない", async () => {
    const pool = await createBlankDatabase(DB_BOTH_PRESENT);
    await runMigrations(pool); // 新名の台帳ができる（この時点で全ファイルが適用済み）
    await pool.query(LEGACY_LEDGER_DDL); // 取り残された旧名の台帳を後から置く
    await pool.query("INSERT INTO _mnemo_migrations (name) VALUES ($1)", [SENTINEL_ROW]);

    await expect(runMigrations(pool)).resolves.toEqual({
      applied: [],
      lock: { waitedMs: expect.any(Number) },
    });

    expect(await ledgerNames(pool, "_mnemora_migrations")).toEqual(ALL_MIGRATION_FILES);

    expect(await legacyLedgerExists(pool)).toBe(true);
    expect(await ledgerNames(pool, "_mnemo_migrations")).toEqual([SENTINEL_ROW]);
  });
});
