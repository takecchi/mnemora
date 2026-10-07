import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  MigrationLockTimeoutError,
  MigrationLockUnavailableError,
  listMigrationFiles,
  runMigrations,
} from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/** 期待値をハードコードすると `migrations/` にファイルが増えるたびに歯が転ぶので、`listMigrationFiles(DEFAULT_MIGRATIONS_DIR)` を唯一の真実の源にして、期待値をそこから導出する。 */
const ALL_MIGRATION_FILES = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);

/**
 * 4本の歯: 1. 並行（N 本同時に呼んでも、DB が壊れず、実際に適用したのはちょうど1本）。2. 待った→取れた（先客が少し後に手放す。`lock.waitedMs` に待った時間が乗る）。
 * 3. 待った→時間切れ（先客が手放さない。`MigrationLockTimeoutError` で落ち、黙って続行して成功しない）。4. ロック機構が使えなかった（`pg_advisory_lock` の実行権限が無いロールでは `MigrationLockUnavailableError` で落ち、時間切れと取り違えない）。
 *
 * テストごとに独立したデータベースを作る。advisory lock はデータベースクラスタ全体で共有される名前空間を持つので、DB を分けて「まっさらな DB に対する migrate」という前提を独立に保つ。
 * ロックそのものの独立性は歯3・4で `lockKey` オプションを都度変えて確保する（同じ DB を複数の it() が使い回すので、鍵を共有すると前の it() のロック残骸に当たる）。
 */

const DB_CONCURRENT = "mnemora_lock_concurrent";
const DB_WAITED = "mnemora_lock_waited";
const DB_TIMEOUT = "mnemora_lock_timeout";
const DB_UNAVAILABLE = "mnemora_lock_unavailable";

const RESTRICTED_ROLE = "mnemora_lock_denied_role";
/** 歯4専用の固定パスワード。値そのものに意味は無く、CI（scram/md5 認証）でこのロールに実際に接続できることが目的。 */
const RESTRICTED_ROLE_PASSWORD = "mnemora-lock-denied-role-password";

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

/**
 * `user` を指定するときは `password` も明示的に渡すこと。`url.username` だけ差し替えて `url.password` を残すと、別ロールへ管理ロールのパスワードを流用してしまう。
 * 手元の `trust` 認証では問題が顕在化しないが、CI の scram/md5 認証では接続そのものが落ち、「ロック機構が使えない」ではなく「そもそも繋がらない」を測ってしまって歯が空振りする。
 */
function connectionStringFor(
  database: string,
  credentials?: { user: string; password: string },
): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 10 });
  openedPools.push(pool);
  return pool;
}

/**
 * 別セッションから advisory lock を握る（テストの「先客」役）。この client も `openedPools` に登録し、pool を閉じるのは `afterAll` に一本化する（同じ pool を2箇所で `end()` すると `pg-pool` が例外を投げるため）。
 */
async function grabLockFromAnotherSession(
  database: string,
  lockKey: bigint,
): Promise<{ release: () => Promise<void> }> {
  const client = new Pool({ connectionString: connectionStringFor(database), max: 1 });
  openedPools.push(client);
  await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
  return {
    release: async () => {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]);
    },
  };
}

describe("runMigrations の排他（advisory lock）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    if (adminPool) {
      await adminPool.query(`DROP OWNED BY ${RESTRICTED_ROLE}`).catch(() => {});
      await adminPool.query(`DROP ROLE IF EXISTS ${RESTRICTED_ROLE}`).catch(() => {});
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("まっさらな DB へ4プロセス相当が同時に migrate しても、成功しかつ適用は1本だけ", async () => {
    const pool = await createBlankDatabase(DB_CONCURRENT);
    // 各「プロセス」に見立てて、コネクションプールを分ける（同一 Pool を共有すると論理的な区別が付かないため）。
    const pools = Array.from(
      { length: 4 },
      () => new Pool({ connectionString: connectionStringFor(DB_CONCURRENT), max: 2 }),
    );
    openedPools.push(...pools);

    const results = await Promise.all(pools.map((p) => runMigrations(p)));

    const appliedCounts = results.map((r) => r.applied.length);
    // 4本のうち、実際にファイルを適用した「プロセス」はちょうど1本。何本を適用したかは「未適用ファイルの総数」で測り、ハードコードしない。
    expect(appliedCounts.filter((n) => n > 0)).toHaveLength(1);
    expect(appliedCounts.reduce((a, b) => a + b, 0)).toBe(ALL_MIGRATION_FILES.length);

    for (const r of results) {
      expect(typeof r.lock.waitedMs).toBe("number");
      expect(r.lock.waitedMs).toBeGreaterThanOrEqual(0);
    }

    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC",
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      "_mnemora_migrations",
      "labels",
      "memories",
      "memory_events",
      "memory_labels",
      "memory_relations",
      "observations",
      "outbox",
      "recall_usages",
      "recalls",
      "tenant_activity",
      "tenant_settings",
      "tenant_subject_activity",
    ]);
    const ledger = await pool.query<{ name: string }>(
      "SELECT name FROM _mnemora_migrations ORDER BY name ASC",
    );
    expect(ledger.rows).toEqual(ALL_MIGRATION_FILES.map((name) => ({ name })));
  }, 20_000);

  it("先客が手放すまで待ってから migrate が進み、待った時間が戻り値に出る", async () => {
    const lockKey = 111111111111111n;
    const pool = await createBlankDatabase(DB_WAITED);
    const holder = await grabLockFromAnotherSession(DB_WAITED, lockKey);

    const HOLD_MS = 1500;
    const releaseTimer = setTimeout(() => {
      void holder.release();
    }, HOLD_MS);

    const startedAt = Date.now();
    const result = await runMigrations(pool, undefined, { lockKey, lockTimeoutMs: 10_000 });
    const elapsedMs = Date.now() - startedAt;

    clearTimeout(releaseTimer);
    // 待った分だけ経過している。余裕を見て HOLD_MS の半分以上とする。
    expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS / 2);
    expect(result.lock.waitedMs).toBeGreaterThanOrEqual(HOLD_MS / 2);
    expect(result.applied).toEqual(ALL_MIGRATION_FILES);
  }, 20_000);

  it("先客が手放さないと、短いタイムアウトで MigrationLockTimeoutError を投げる（黙って続行しない）", async () => {
    const lockKey = 222222222222222n;
    const pool = await createBlankDatabase(DB_TIMEOUT);
    const holder = await grabLockFromAnotherSession(DB_TIMEOUT, lockKey);

    try {
      await expect(
        runMigrations(pool, undefined, { lockKey, lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

      const tables = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await holder.release();
    }
  }, 20_000);

  // 本物の PostgreSQL で作る: 通常ロールを作り、`pg_advisory_lock(bigint)` の EXECUTE 権限を PUBLIC から剥奪する。superuser は権限チェックを迂回するので、非 superuser の別ロールで接続する。
  it("advisory lock を取る権限が無いロールで呼ぶと、MigrationLockUnavailableError を投げる（時間切れと区別できる）", async () => {
    const lockKey = 333333333333333n;
    const pool = await createBlankDatabase(DB_UNAVAILABLE);

    // パスワードは固定で作る/更新する（既存ロールが残っていても揃える）。DO ブロックはリテラル文字列を要求するので、値は定数の `RESTRICTED_ROLE_PASSWORD` のみを埋め込む。
    await admin().query(
      `DO $do$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RESTRICTED_ROLE}') THEN
             CREATE ROLE ${RESTRICTED_ROLE} LOGIN PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
           ELSE
             ALTER ROLE ${RESTRICTED_ROLE} PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
           END IF;
         END $do$;`,
    );
    const restrictedPool = new Pool({
      connectionString: connectionStringFor(DB_UNAVAILABLE),
      max: 1,
    });
    await restrictedPool.query(`GRANT CONNECT ON DATABASE ${DB_UNAVAILABLE} TO ${RESTRICTED_ROLE}`);
    await restrictedPool.query(`REVOKE EXECUTE ON FUNCTION pg_advisory_lock(bigint) FROM PUBLIC`);
    await restrictedPool.end();

    const deniedPool = new Pool({
      connectionString: connectionStringFor(DB_UNAVAILABLE, {
        user: RESTRICTED_ROLE,
        password: RESTRICTED_ROLE_PASSWORD,
      }),
      max: 1,
    });
    openedPools.push(deniedPool);

    try {
      await expect(
        runMigrations(deniedPool, undefined, { lockKey, lockTimeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(MigrationLockUnavailableError);

      const tables = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(tables.rows).toEqual([]);
    } finally {
      const restorePool = new Pool({
        connectionString: connectionStringFor(DB_UNAVAILABLE),
        max: 1,
      });
      await restorePool.query(`GRANT EXECUTE ON FUNCTION pg_advisory_lock(bigint) TO PUBLIC`);
      await restorePool.end();
    }
  }, 20_000);
});
