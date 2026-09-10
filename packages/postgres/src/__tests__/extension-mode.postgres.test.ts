import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MissingExtensionsError, REQUIRED_EXTENSIONS, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `extensionMode: "verify"`（ADR 0093）を本物の PostgreSQL に対して測る歯。
 *
 * ## 何を測るか
 *
 * ADR 0093 の動機の実例（virchamate）をそのまま再現する: 「DB オーナーが承認したのは
 * `btree_gin` と `pgcrypto` の2文だけで、mnemora が発行する `vector` は承認された範囲の
 * 外にある」——つまり **`vector` だけが未設置の DB に、`CREATE EXTENSION` 権限を
 * 持たないロールで接続する**、という状況そのものを作る。
 *
 * ## 確かめた前提（実測ではなく、PostgreSQL 本体のソースコードで裏取りした事実）
 *
 * PostgreSQL の `CreateExtension()`（`src/backend/commands/extension.c`）は、
 * `IF NOT EXISTS` 付きで指定した拡張が**既に存在する**場合、`get_extension_oid` で
 * 既存を検出した時点で NOTICE を出して早期リターンする——`CreateExtensionInternal` 内の
 * 権限チェック（superuser 判定・対象スキーマへの CREATE 権限）には**到達しない**。
 *
 * ⟹ **「拡張が既に全部揃っている」状況では、`extensionMode: "create"`（既定）も
 * 実は権限の無いロールで成功してしまう**（Postgres 自身が権限チェックをスキップする
 * ため）。verify モードがこの状況で持つ意味は「CREATE EXTENSION 文を一切送らない」こと
 * そのもの（DBA が承認した文以外を送らないという監査・ガバナンス上の要求）であって、
 * 「揃っている場合に create モードが落ちる」という主張ではない。**この歯はその区別を
 * 誤魔化さない**——create モードと verify モードの生の失敗を対照する測定4は、
 * 「拡張が足りない」状況でだけ行う。
 *
 * 測定1〜3 は superuser の pool（使い捨て DB を丸ごと操作できる pool）で行い、
 * 測定4だけ、`CREATE EXTENSION` の権限を持たない実ロールを使う
 * （`migrate-concurrency.test.ts` の `RESTRICTED_ROLE` と同じ作り方）。
 */

const DB_ALL_PRESENT = "mnemora_extmode_all_present";
const DB_SCHEMA_VERIFY = "mnemora_extmode_schema_verify";
const DB_MISSING_VERIFY = "mnemora_extmode_missing_verify";
const DB_MISSING_CREATE_DEFAULT = "mnemora_extmode_missing_create_default";
const DB_RESTRICTED_ROLE = "mnemora_extmode_restricted_role";

const RESTRICTED_ROLE = "mnemora_extmode_denied_role";
/** 値そのものに意味は無い。CI（scram/md5 認証）でこのロールに実際に接続できることが目的。 */
const RESTRICTED_ROLE_PASSWORD = "mnemora-extmode-denied-role-password";

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

/**
 * `user` を指定するときは `password` も明示的に渡すこと（`migrate-concurrency.test.ts` の
 * 同名関数と同じ理由: `url.password` を残したまま `url.username` だけ差し替えると、
 * 別ロールへ管理ロールのパスワードを流用してしまい、CI の scram/md5 認証で
 * 「そもそも繋がらない」という別の失敗に化ける）。
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

/** 使い捨てのデータベースを作り、専用の Pool を返す（`temp-database.ts` の作法どおり FORCE を使わない）。 */
async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 5 });
  openedPools.push(pool);
  return pool;
}

/** `table`（裸の名前、既定の search_path = public）が存在するかどうか。 */
async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ oid: string | null }>(`SELECT to_regclass($1)::text AS oid`, [
    table,
  ]);
  return rows[0]!.oid !== null;
}

describe("extensionMode: 'verify'（ADR 0093、本物の PostgreSQL）", () => {
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

  it("測定1: 拡張が全部揃っていれば、CREATE EXTENSION を発行せずに一式が出来る", async () => {
    const pool = await createBlankDatabase(DB_ALL_PRESENT);
    for (const ext of REQUIRED_EXTENSIONS) {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }

    const result = await runMigrations(pool, undefined, { extensionMode: "verify" });

    expect(result.extensionCheck).toEqual({ verified: REQUIRED_EXTENSIONS });
    expect(await tableExists(pool, "observations")).toBe(true);
    expect(await tableExists(pool, "memories")).toBe(true);
  });

  it("測定1b: 専用スキーマ（経路1）でも verify は CREATE EXTENSION を発行せず、CREATE SCHEMA は今日どおり発行する", async () => {
    const pool = await createBlankDatabase(DB_SCHEMA_VERIFY);
    for (const ext of REQUIRED_EXTENSIONS) {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }

    const result = await runMigrations(pool, undefined, {
      schema: "mnemora_ext_verify",
      extensionMode: "verify",
    });

    expect(result.extensionCheck).toEqual({ verified: REQUIRED_EXTENSIONS });
    const { rows } = await pool.query<{ oid: string | null }>(
      `SELECT to_regclass('"mnemora_ext_verify"."observations"')::text AS oid`,
    );
    expect(rows[0]!.oid, "専用スキーマ側に observations が作られていること").not.toBeNull();
  });

  it("測定2: 拡張が足りない（virchamate の実例どおり vector だけ無い）と MissingExtensionsError で落ち、DB に何も作らない", async () => {
    const pool = await createBlankDatabase(DB_MISSING_VERIFY);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    const err = await runMigrations(pool, undefined, { extensionMode: "verify" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MissingExtensionsError);
    expect((err as MissingExtensionsError).missing).toEqual(["vector"]);
    expect((err as MissingExtensionsError).message).toContain(
      "CREATE EXTENSION IF NOT EXISTS vector;",
    );
    expect(await tableExists(pool, "observations")).toBe(false);
  });

  it("測定3（対照）: 同じ状況で create モード（既定）は superuser なら今日どおり成功する（既定の挙動は変えていない）", async () => {
    const pool = await createBlankDatabase(DB_MISSING_CREATE_DEFAULT);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    const result = await runMigrations(pool);

    expect(result.extensionCheck).toBeUndefined();
    expect(await tableExists(pool, "observations")).toBe(true);
  });

  it("測定4: CREATE EXTENSION 権限を持たない実ロールで virchamate の状況を再現する——create モードは生の権限エラーで落ち、verify モードは制御されたエラーで落ち、拡張が揃った後は同じロールで成功する", async () => {
    const pool = await createBlankDatabase(DB_RESTRICTED_ROLE);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // PostgreSQL 15+ は既定で public への CREATE を PUBLIC から剥奪しているはずだが、
    // イメージ側の初期化スクリプトに依存させない——ここで明示的に剥奪し、
    // 「trusted 拡張なら CREATE 権限だけで作れてしまう」経路も塞いでおく。
    await pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);

    await admin().query(
      `DO $do$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RESTRICTED_ROLE}') THEN
             CREATE ROLE ${RESTRICTED_ROLE} LOGIN PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
           ELSE
             ALTER ROLE ${RESTRICTED_ROLE} PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
           END IF;
         END $do$;`,
    );
    await pool.query(`GRANT CONNECT ON DATABASE ${DB_RESTRICTED_ROLE} TO ${RESTRICTED_ROLE}`);
    // これ以外は何も許可しない——CREATE EXTENSION に要る権限
    // （superuser、または trusted 拡張向けの対象スキーマへの CREATE 権限）を
    // 一切持たないロールにする。

    const restrictedPool = new Pool({
      connectionString: connectionStringFor(DB_RESTRICTED_ROLE, {
        user: RESTRICTED_ROLE,
        password: RESTRICTED_ROLE_PASSWORD,
      }),
      max: 1,
    });
    openedPools.push(restrictedPool);

    // 4a: create モード（既定）は、0001_init.sql 本文の最初の文（CREATE EXTENSION vector）が
    // 生の Postgres の権限エラーで落ちる——これが今日の mnemora が
    // 導入者を締め出す実際の壊れ方（制御されていない失敗）。
    const createModeErr = await runMigrations(restrictedPool).catch((e: unknown) => e);
    expect(createModeErr).toBeInstanceOf(Error);
    expect(createModeErr).not.toBeInstanceOf(MissingExtensionsError);
    expect(await tableExists(pool, "observations")).toBe(false);

    // 4b: 同じロール・同じ状況で verify モードは制御された MissingExtensionsError になる。
    const verifyModeErr = await runMigrations(restrictedPool, undefined, {
      extensionMode: "verify",
    }).catch((e: unknown) => e);
    expect(verifyModeErr).toBeInstanceOf(MissingExtensionsError);
    expect((verifyModeErr as MissingExtensionsError).missing).toEqual(["vector"]);
    expect(await tableExists(pool, "observations")).toBe(false);

    // 5: superuser が vector を設置すれば（DBA が承認した SQL を実行する、という
    // ADR 0093 が想定する運用そのもの）、権限を持たない同じロールで verify モードが
    // 成功し、一式ができる。
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    const result = await runMigrations(restrictedPool, undefined, { extensionMode: "verify" });
    expect(result.extensionCheck).toEqual({ verified: REQUIRED_EXTENSIONS });
    expect(await tableExists(pool, "observations")).toBe(true);
  });
});
