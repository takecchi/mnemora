import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  RegisterEmbeddingSpaceLockTimeoutError,
  RegisterEmbeddingSpaceLockUnavailableError,
  registerEmbeddingSpace,
} from "../vector-space.js";
import { embeddingSpaceIndexName, embeddingSpaceTableName } from "../embedding-space-table.js";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `registerEmbeddingSpace` の排他（段階2・ADR 0018）を検査する。
 *
 * 段階1の実測（ADR 0018 の「段階1の実測」）で、まっさらな DB へ複数プロセスが同時に
 * `registerEmbeddingSpace` を呼ぶと**決定的に**（試行した全件で）どちらか一方が落ちる
 * ことを確認した。衝突点は `CREATE TABLE IF NOT EXISTS`（`pg_type_typname_nsp_index`）と
 * `CREATE INDEX IF NOT EXISTS`（`pg_class_relname_nsp_index`）の**両方**に独立して存在する。
 * ここでは「advisory lock で塞いだこと」を直接測る——DDL の中身ではなく、
 * `registerEmbeddingSpace` の入り口の排他そのものを検査対象にする。
 *
 * 構造は `migrate-concurrency.test.ts` をそのまま踏襲する（テストごとに独立した
 * データベースを作る理由・`lockKey` を it ごとに変える理由は、同ファイル冒頭の
 * コメントを参照。advisory lock の名前空間がデータベースクラスタ全体で共有される
 * こと、既存の it() のロック残骸に当たるリスクを避けるためという理由は同じ）。
 *
 * オーナーが引いた線（3状態を混同しないこと）に対応する5本の歯:
 * 1a. まっさらな DB へ N=4 同時: テーブル層（`pg_type_typname_nsp_index`）の衝突点を通る経路。
 * 1b. テーブルだけ先に1プロセスで直列に作っておき（索引は作らない）、N=4 同時に呼ぶ:
 *     索引層（`pg_class_relname_nsp_index`）の衝突点を通る経路。
 *
 *     **なぜ「テーブルと索引を両方先に作っておく」ではなく「テーブルだけ」なのか**:
 *     `registerEmbeddingSpace` を先に1回成功させて索引まで作ってしまうと、2回目以降の
 *     `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` はどちらも
 *     「既に存在する」ことがコミット済みで全セッションから見えるため、advisory lock を
 *     外した変異版でも非アトミックな競合そのものが起こらず（両方とも即座に no-op で
 *     抜けるだけ）、歯が変異を検知できない（実測して確認した——後述）。索引だけ
 *     未作成の状態を作ることで、変異版が索引層の衝突を確実に踏むようにしてある。
 * 2.  先客が少し後に手放す → 待って進み、`lock.waitedMs` に待ち時間が乗る。
 * 3.  先客が手放さない → 時間切れのエラーで落ちる（黙って続行して成功しない）。
 * 4.  `pg_advisory_lock` の EXECUTE 権限が無いロールで呼ぶ → 時間切れとは別のエラーで落ちる。
 */

const DB_CONCURRENT_TABLE = "mnemora_vs_lock_concurrent_table";
const DB_CONCURRENT_INDEX = "mnemora_vs_lock_concurrent_index";
const DB_WAITED = "mnemora_vs_lock_waited";
const DB_TIMEOUT = "mnemora_vs_lock_timeout";
const DB_UNAVAILABLE = "mnemora_vs_lock_unavailable";

const RESTRICTED_ROLE = "mnemora_vs_lock_denied_role";
/** 歯4専用の固定パスワード（`migrate-concurrency.test.ts` と同じ理由。値そのものに意味は無い）。 */
const RESTRICTED_ROLE_PASSWORD = "mnemora-vs-lock-denied-role-password";

const SPACE = { provider: "test", model: "vs-concurrency-fixture", dimensions: 4 };
const TABLE = embeddingSpaceTableName(SPACE);
const INDEX = embeddingSpaceIndexName(SPACE);

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

/**
 * `user` を指定するときは `password` も明示的に渡すこと。理由は
 * `migrate-concurrency.test.ts` の同名関数のコメントと同じ（CI の scram/md5 認証で
 * 管理ロールのパスワードを無関係なロールへ流用してしまう事故を避けるため）。
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

async function createMigratedDatabase(database: string): Promise<Pool> {
  // FORCE を使わない理由は temp-database.ts 冒頭のコメント（ADR 0020）を参照。
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 10 });
  openedPools.push(pool);
  // registerEmbeddingSpace の FK 先である memories テーブルを用意する
  // （runtime-factory.ts の実際の順序と同じ: runMigrations の後に registerEmbeddingSpace）。
  await runMigrations(pool);
  return pool;
}

/** テーブルだけを直列に作る（索引は作らない）。歯1b 専用のセットアップ。 */
async function createTableOnly(pool: Pool): Promise<void> {
  // vector-space.ts の第1文とまったく同じ SQL（索引を作る第2文は含めない）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      tenant_id   text         NOT NULL,
      memory_id   uuid         NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      embedding   vector(${SPACE.dimensions}) NOT NULL,
      model       text         NOT NULL,
      created_at  timestamptz  NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, memory_id)
    );
  `);
}

/**
 * 別セッションから advisory lock を握る（テストの「先客」役）。
 *
 * この client も `openedPools` に登録し、`afterAll` の一括 `pool.end()` に委ねる
 * （以前は登録されておらず、`afterAll` が把握しないまま残る接続だった）。
 * `release()` はロックを手放すことだけを担い、pool を閉じるのは `afterAll` の役目に
 * 一本化する——同じ pool を2箇所で `end()` すると `pg-pool` が
 * 「Called end on pool more than once」で例外を投げるため。
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

async function existingRelations(pool: Pool): Promise<{ tables: string[]; indexes: string[] }> {
  const t = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=$1",
    [TABLE],
  );
  const i = await pool.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=$1",
    [INDEX],
  );
  return { tables: t.rows.map((r) => r.tablename), indexes: i.rows.map((r) => r.indexname) };
}

describe("registerEmbeddingSpace の排他（advisory lock）", () => {
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

  // 歯1a: まっさらな DB へ4プロセス相当が同時に registerEmbeddingSpace しても、
  // 全部成功し、テーブル・索引が正しく1組だけ出来ている。
  //
  // **この歯に変異（ロックを外す）を当てると赤くなることを確かめてある
  // （PR 本文に diff と出力を記載）。** 段階1の実測では、この形（まっさらな DB へ
  // N=4 同時）はテーブル層（`pg_type_typname_nsp_index`）で12/12決定的に落ちた。
  it("まっさらな DB へ4プロセス相当が同時に registerEmbeddingSpace しても、全部成功しテーブル・索引が1組だけ出来ている", async () => {
    const pool = await createMigratedDatabase(DB_CONCURRENT_TABLE);
    const pools = Array.from(
      { length: 4 },
      () => new Pool({ connectionString: connectionStringFor(DB_CONCURRENT_TABLE), max: 2 }),
    );
    openedPools.push(...pools);

    const results = await Promise.all(pools.map((p) => registerEmbeddingSpace(p, SPACE)));

    for (const r of results) {
      expect(typeof r.lock.waitedMs).toBe("number");
      expect(r.lock.waitedMs).toBeGreaterThanOrEqual(0);
    }

    const relations = await existingRelations(pool);
    expect(relations.tables).toEqual([TABLE]);
    expect(relations.indexes).toEqual([INDEX]);
  }, 20_000);

  // 歯1b: テーブルだけ先に直列で作っておき（索引は無い状態）、4プロセス相当が
  // 同時に registerEmbeddingSpace しても、全部成功し索引が正しく1本だけ出来ている。
  //
  // **この歯に変異を当てると、索引層（`pg_class_relname_nsp_index`）で赤くなることを
  // 確かめてある（PR 本文参照）。** テーブルと索引の両方を先に作ってしまう形では
  // 変異が検知できないことも実測済み（歯の先頭コメント参照）。
  it("テーブルだけ先に作った状態で4プロセス相当が同時に呼んでも、全部成功し索引が1本だけ出来ている", async () => {
    const pool = await createMigratedDatabase(DB_CONCURRENT_INDEX);
    await createTableOnly(pool);

    const pools = Array.from(
      { length: 4 },
      () => new Pool({ connectionString: connectionStringFor(DB_CONCURRENT_INDEX), max: 2 }),
    );
    openedPools.push(...pools);

    const results = await Promise.all(pools.map((p) => registerEmbeddingSpace(p, SPACE)));

    for (const r of results) {
      expect(typeof r.lock.waitedMs).toBe("number");
      expect(r.lock.waitedMs).toBeGreaterThanOrEqual(0);
    }

    const relations = await existingRelations(pool);
    expect(relations.tables).toEqual([TABLE]);
    expect(relations.indexes).toEqual([INDEX]);
  }, 20_000);

  // 歯2: 先客が少し後に手放す → 待ってから registerEmbeddingSpace が進み、
  // 待った時間が戻り値に出る。
  it("先客が手放すまで待ってから進み、待った時間が戻り値に出る", async () => {
    const lockKey = 444444444444444n;
    const pool = await createMigratedDatabase(DB_WAITED);
    const holder = await grabLockFromAnotherSession(DB_WAITED, lockKey);

    const HOLD_MS = 1500;
    const releaseTimer = setTimeout(() => {
      void holder.release();
    }, HOLD_MS);

    const startedAt = Date.now();
    const result = await registerEmbeddingSpace(pool, SPACE, { lockKey, lockTimeoutMs: 10_000 });
    const elapsedMs = Date.now() - startedAt;

    clearTimeout(releaseTimer);
    expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS / 2);
    expect(result.lock.waitedMs).toBeGreaterThanOrEqual(HOLD_MS / 2);

    const relations = await existingRelations(pool);
    expect(relations.tables).toEqual([TABLE]);
    expect(relations.indexes).toEqual([INDEX]);
  }, 20_000);

  // 歯3: 先客が手放さない → 短いタイムアウトで RegisterEmbeddingSpaceLockTimeoutError
  // を投げる（黙って続行しない）。
  //
  // **この歯に変異（ロックを外す）を当てると、時間切れにならず普通に成功して
  // 赤くなることを確かめてある。**
  it("先客が手放さないと、短いタイムアウトで RegisterEmbeddingSpaceLockTimeoutError を投げる", async () => {
    const lockKey = 555555555555555n;
    const pool = await createMigratedDatabase(DB_TIMEOUT);
    const holder = await grabLockFromAnotherSession(DB_TIMEOUT, lockKey);

    try {
      await expect(
        registerEmbeddingSpace(pool, SPACE, { lockKey, lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(RegisterEmbeddingSpaceLockTimeoutError);

      // 時間切れの後、DB には何も作られていない（黙って続行していない証拠）。
      const relations = await existingRelations(pool);
      expect(relations.tables).toEqual([]);
      expect(relations.indexes).toEqual([]);
    } finally {
      await holder.release();
    }
  }, 20_000);

  // 歯4: ロック機構自体が使えない（権限が無い）→ 時間切れとは別のエラーで落ちる。
  it("advisory lock を取る権限が無いロールで呼ぶと、RegisterEmbeddingSpaceLockUnavailableError を投げる", async () => {
    const lockKey = 666666666666666n;
    const pool = await createMigratedDatabase(DB_UNAVAILABLE);

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
        registerEmbeddingSpace(deniedPool, SPACE, { lockKey, lockTimeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(RegisterEmbeddingSpaceLockUnavailableError);

      const relations = await existingRelations(pool);
      expect(relations.tables).toEqual([]);
      expect(relations.indexes).toEqual([]);
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
