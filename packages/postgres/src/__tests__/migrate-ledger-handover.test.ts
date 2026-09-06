import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * マネージャー指摘（`0002_outbox_claim_lease_index.sql` の追加で判明）: このファイルの
 * 期待値を `["0001_init.sql"]`・`applied: []` のようにハードコードすると、
 * `migrations/` にファイルが増えるたびに歯が転ぶ——「0001 が再実行されない」という
 * 測りたい不変条件と、「1本しかマイグレーションが無い」という前提を混同していた。
 * `listMigrationFiles(DEFAULT_MIGRATIONS_DIR)` を唯一の真実の源にして期待値を導出する。
 *
 * `seedLegacyDatabase` は `0001_init.sql` だけを旧名の台帳経由で適用する（改名前の
 * DB を再現するため）。0001 より後に増えたファイル（この時点では 0002）は
 * `seedLegacyDatabase` の対象外——旧い DB には存在しなかったファイルなので、
 * 引き継ぎ後の最初の `runMigrations` で初めて適用される。この「引き継いだ0001は
 * 再実行しないが、その後に増えたファイルは適用する」という区別こそが本ファイルの
 * 検査対象であり、`NON_LEGACY_FILES` はそれを表す。
 */
const ALL_MIGRATION_FILES = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
const NON_LEGACY_FILES = ALL_MIGRATION_FILES.filter((name) => name !== "0001_init.sql");

/**
 * マイグレーション台帳の旧名からの引き継ぎ（`_mnemo_migrations` → `_mnemora_migrations`）を
 * 検査する。
 *
 * **まっさらな DB で migrate が通ることは、この引き継ぎを何も測っていない。**
 * 引き継ぎが効くのは「旧名の台帳が入った DB」に対してだけなので、その旧い状態を
 * **こちらで作ってから**測る。
 *
 * ## なぜテスト専用の「データベース」を作るのか（スキーマではなく）
 *
 * 引き継ぎの判定は `to_regclass('_mnemora_migrations')` である。これは `search_path` を
 * 辿って解決するため、**共有 DB の中に専用スキーマを切って `search_path` を
 * `<schema>,public` に向ける形では隔離できない**——CI は本番の台帳を `public` に
 * 作った状態でテストへ入る（ワークフローがテストの前に `run migrate` する）ので、
 * `to_regclass` が `public._mnemora_migrations` を拾ってしまい、「新名は既に在る」と
 * 誤判定して引き継ぎが起きない。
 *
 * かといって `search_path` から `public` を外すと、`0001_init.sql` の
 * `CREATE INDEX idx_memories_tags ON memories USING gin (tenant_id, tags)` が
 * `public` に入っている btree_gin の operator class を解決できずに落ちる。
 *
 * **どちらにも倒れないので、テストごとに独立したデータベースを作って捨てる。**
 * 副作用として、5番目の歯の「まっさらな DB」が**本当にまっさらな DB**になる。
 *
 * **前提**: 接続ロールが `CREATE DATABASE` と `CREATE EXTENSION` を行えること。
 * CI の service container は `postgres`（superuser）で接続するため満たしている
 * （ワークフローが同じ権限で `CREATE EXTENSION` を実行している）。
 */

/** テストごとに作って捨てるデータベース。名前は固定にして、落ちた回の残骸も拾えるようにする。 */
const DB_NOT_REAPPLIED = "mnemora_ledger_handover_not_reapplied";
const DB_ROWS_CARRIED = "mnemora_ledger_handover_rows_carried";
const DB_BLANK = "mnemora_ledger_handover_blank";
const DB_BOTH_PRESENT = "mnemora_ledger_handover_both_present";

/**
 * 台帳が「引き継がれた」のか「作り直された」のかを見分けるための目印。
 *
 * `0001_init.sql` の行だけを見ても、**空の台帳を作って 0001 を適用し直した場合と
 * 区別できない**（どちらも「0001_init.sql が1行」になる）。実在しないマイグレーション名を
 * 1行混ぜておくと、作り直しでは絶対に復元されない。
 */
const SENTINEL_ROW = "0000_row_that_only_a_handover_can_carry.sql";

/**
 * 改名前のコードが作っていた台帳の DDL を、そのまま写したもの。
 *
 * **意図的な複製である。**「改名前の DB がどうなっていたか」はもう変わらない歴史上の
 * 事実なので、`migrate.ts` の現在の定義を参照してはいけない——参照すると、検査対象を
 * 直したときに検査のほうも一緒に動いてしまい、引き継ぎを測らなくなる。
 */
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

/**
 * 空のデータベースを作り、そこへ向いた Pool を返す。
 *
 * データベース名はこのファイル内の定数だけなので、識別子をそのまま SQL へ埋めてよい
 * （`CREATE DATABASE` の名前はパラメータ化できない）。
 */
async function createBlankDatabase(database: string): Promise<Pool> {
  // FORCE を使わない理由は temp-database.ts 冒頭のコメント（ADR 0020）を参照。
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 2 });
  openedPools.push(pool);
  return pool;
}

/**
 * 「改名前に作られ、`0001_init.sql` まで適用済みだった DB」を再現する。
 *
 * `runMigrations` は通さない——**検査対象の側を通して旧い状態を作ると、
 * 引き継ぎが壊れたときに前提のほうも一緒に壊れて、歯が空振りする。**
 */
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

  // 歯1: 「落ちない」ことだけを測る。旧名の台帳が引き継がれなければ 0001_init.sql が
  // 再実行され、`CREATE TABLE observations`（IF NOT EXISTS 無し）で必ず落ちる。
  it("旧名の台帳が在る DB へ migrate しても 0001_init.sql は再実行されない", async () => {
    const pool = await createBlankDatabase(DB_NOT_REAPPLIED);
    await seedLegacyDatabase(pool);

    // 引き継ぎにより 0001_init.sql は「適用済み」として扱われ、再実行されない
    // ——これが測りたい不変条件。0001 より後に増えた未適用ファイル（この時点では
    // 0002_outbox_claim_lease_index.sql）は、旧い DB には存在しなかった以上
    // ここで初めて適用されるのが正しい（「何も適用しない」ことは測りたい不変条件では
    // ない。マネージャー指摘: ここを `applied: []` に固定すると、ファイルが増える
    // たびに歯が転ぶ）。
    const first = await runMigrations(pool);
    expect(first.applied).not.toContain("0001_init.sql");
    expect(first.applied).toEqual(NON_LEGACY_FILES);

    // 冪等: 引き継ぎ済み・かつ全ファイル適用済みの DB へもう一度走らせても何もしない。
    await expect(runMigrations(pool)).resolves.toEqual({
      applied: [],
      lock: { waitedMs: expect.any(Number) },
    });
  });

  // 歯2: 歯1とは別に立てる。**落ちないだけなら台帳を空にしても通ってしまう**ため、
  // 「行が引き継がれた」ことは独立に測らなければならない。
  it("旧名の台帳の行が、新名の台帳へそのまま引き継がれる（作り直されない）", async () => {
    const pool = await createBlankDatabase(DB_ROWS_CARRIED);
    await seedLegacyDatabase(pool);
    await pool.query("INSERT INTO _mnemo_migrations (name) VALUES ($1)", [SENTINEL_ROW]);

    const before = await pool.query<{ name: string; applied_at: Date }>(
      "SELECT name, applied_at FROM _mnemo_migrations ORDER BY name ASC",
    );
    expect(before.rows.map((row) => row.name)).toEqual([SENTINEL_ROW, "0001_init.sql"]);

    await runMigrations(pool);

    // 旧名は消えている（引き継ぎは RENAME であって、コピーではない）。
    expect(await legacyLedgerExists(pool)).toBe(false);

    // 引き継いだ行（SENTINEL_ROW・0001_init.sql）は、`applied_at` まで一致したまま
    // 新名の台帳に残っている——作り直せば now() で入り直すので、必ず違う値になる。
    // 0001 より後の未適用ファイル（この時点では 0002）はこの呼び出しで新たに
    // 適用されるため、新名の台帳の行数は「引き継いだ分 + 新規適用分」になる
    // （マネージャー指摘: 行数をそのまま固定すると、ファイルが増えるたびに歯が転ぶ）。
    const after = await pool.query<{ name: string; applied_at: Date }>(
      "SELECT name, applied_at FROM _mnemora_migrations ORDER BY name ASC",
    );
    const carriedRows = after.rows.filter((row) =>
      before.rows.some((beforeRow) => beforeRow.name === row.name),
    );
    expect(carriedRows).toEqual(before.rows);
    expect(after.rows).toHaveLength(before.rows.length + NON_LEGACY_FILES.length);
  });

  // 歯3: 引き継ぎが無害であること。旧名が無い DB では何もしない。
  it("まっさらな DB でも通る（旧名が無ければ引き継ぎは何もしない）", async () => {
    const pool = await createBlankDatabase(DB_BLANK);

    await expect(runMigrations(pool)).resolves.toEqual({
      applied: ALL_MIGRATION_FILES,
      lock: { waitedMs: expect.any(Number) },
    });
    expect(await ledgerNames(pool, "_mnemora_migrations")).toEqual(ALL_MIGRATION_FILES);
    expect(await legacyLedgerExists(pool)).toBe(false);

    // 二度目は何も適用しない（既存の冪等性が引き継ぎを足しても保たれている）。
    await expect(runMigrations(pool)).resolves.toEqual({
      applied: [],
      lock: { waitedMs: expect.any(Number) },
    });
  });

  // 歯4: 新旧どちらも在るときは触らない。ここで RENAME してしまうと、
  // 生きている台帳を古い台帳で上書きすることになる。
  //
  // **この歯が噛むことは実測してある（PR #11）。**`handOverLegacyMigrationsTable` の
  // 条件から `AND to_regclass('_mnemora_migrations') IS NULL` を落とす変異
  // （＝旧名が在れば常に RENAME する）を当てると、
  // `relation "_mnemora_migrations" already exists` でこの1本だけが赤くなり、
  // 他の3本は緑のままだった——本物の PostgreSQL 18.6 + pgvector 0.8.6 に対する観測である。
  // PR #8 で当てた変異（引き継ぎと台帳作成の順序入れ替え）では、この歯は緑のままだった。
  it("新旧どちらの台帳も在るときは、引き継ぎは何もしない", async () => {
    const pool = await createBlankDatabase(DB_BOTH_PRESENT);
    await runMigrations(pool); // 新名の台帳ができる（この時点で全ファイルが適用済み）
    await pool.query(LEGACY_LEDGER_DDL); // 取り残された旧名の台帳を後から置く
    await pool.query("INSERT INTO _mnemo_migrations (name) VALUES ($1)", [SENTINEL_ROW]);

    await expect(runMigrations(pool)).resolves.toEqual({
      applied: [],
      lock: { waitedMs: expect.any(Number) },
    });

    // 新名の台帳は上書きされていない（目印の行が混ざっていない）。全ファイルが
    // 適用済みのまま変わらない。
    expect(await ledgerNames(pool, "_mnemora_migrations")).toEqual(ALL_MIGRATION_FILES);

    // 旧名のほうも勝手に消さない（中身の突き合わせは人間の判断に属する）。
    expect(await legacyLedgerExists(pool)).toBe(true);
    expect(await ledgerNames(pool, "_mnemo_migrations")).toEqual([SENTINEL_ROW]);
  });
});
