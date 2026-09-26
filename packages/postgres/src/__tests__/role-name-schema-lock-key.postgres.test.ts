import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  MIGRATION_LOCK_KEY,
  MigrationLockTimeoutError,
  migrationLockKeyFor,
  runMigrations,
} from "../migrate.js";
import {
  REGISTER_EMBEDDING_SPACE_LOCK_KEY,
  RegisterEmbeddingSpaceLockTimeoutError,
  registerEmbeddingSpace,
  registerEmbeddingSpaceLockKeyFor,
} from "../vector-space.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * Issue #779 の🟠を直す歯。
 *
 * ## 何が壊れていたか
 *
 * PostgreSQL の既定 `search_path` は `"$user", public` である。接続に使ったロール名と
 * 同じ名前のスキーマが DB に在ると、`schema` オプションを省略した `runMigrations` /
 * `registerEmbeddingSpace` は例外を出さずそのスキーマへ読み書きする（Issue #757 の実測）。
 * ところが `migrationLockKeyFor` / `registerEmbeddingSpaceLockKeyFor` は `schema` 未指定を
 * 「静的には特定できない」として既定の固定キーへ倒していた（ADR 0057 決定6）——結果、
 * **同じ物理スキーマを見ているのに、`schema: "<ロール名>"` を明示指定した別の呼び出しと
 * ロックキーが食い違い、互いを待たない。**
 *
 * ## この歯がどう測るか
 *
 * 「schema 未指定の呼び出しが実際に使うロックキー」を直接読む手段は無い（advisory lock は
 * 内部で取得・解放されるだけで、キーの値そのものは戻り値に出ない）。そのため
 * `migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` と同じ流儀
 * （別セッションから先に advisory lock を握っておき、対象の呼び出しが「待つ／待たない」を
 * `MigrationLockTimeoutError` の有無で観測する）を使う——**特定のキーを先客が握っている
 * ときに、対象の呼び出しがそのキーで待つなら、対象は同じキーを使っている。**
 *
 * ロール名と同名のスキーマを用意した DB では、`schema` 未指定の呼び出しが使うべきキーは
 * `migrationLockKeyFor(<ロール名>)`（＝ `schema: "<ロール名>"` を明示指定したときと同じ
 * 導出キー）である。先客にこのキーを握らせておいて、`schema` 未指定の呼び出しが
 * 短いタイムアウトで `MigrationLockTimeoutError` に落ちれば、「同じキーを使っている
 * （＝互いに待つ）」ことの直接証拠になる。
 *
 * 直す前は、`schema` 未指定の呼び出しは既定の固定キー（`MIGRATION_LOCK_KEY` /
 * `REGISTER_EMBEDDING_SPACE_LOCK_KEY`）のまま——先客が握っている導出キーとは無関係なので
 * **待たずに完了してしまう**（`.rejects.toBeInstanceOf(...)` が「resolved した」で赤くなる）。
 *
 * 陽性対照として、ロール名スキーマが存在しない（＝ `current_schema()` が `public` に
 * 落ちる）DB では、`schema` 未指定の呼び出しは今まで通り既定の固定キーのままであることも
 * 別の it() で固定する——こちらは修正の前後どちらでも緑のまま（ローリングデプロイ中の
 * 互換性を壊していないことの回帰ガード）。
 *
 * ## この試験環境の前提
 *
 * `DATABASE_URL` が指す接続ロール名は `^[a-z_][a-z0-9_]*$` に収まる（`postgres` / `worker`
 * 等）——CI・手元の `initdb` 手順（`AGENTS.md`）のどちらもこの形。ロール名がこの形を
 * 外れる環境ではこの歯の前提が崩れる（確かめていない）。
 */

const DB_MIGRATE_ROLE_SCHEMA = "mnemora_lock_role_schema_migrate";
const DB_MIGRATE_PUBLIC = "mnemora_lock_role_schema_migrate_public";
const DB_VECTOR_ROLE_SCHEMA = "mnemora_lock_role_schema_vector";
const DB_VECTOR_PUBLIC = "mnemora_lock_role_schema_vector_public";

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
 * 使い捨てのデータベースを作り、専用の Pool を返す（`temp-database.ts` の作法どおり
 * FORCE を使わない）。`admin()` と同じロールで接続するため、作った DB の所有者は
 * そのロールになる——後で同名のスキーマを作れば、そのロールは常にオーナー権限を持つ
 * （別ロールを作って GRANT する手間を避けられる）。
 *
 * `vector` 拡張を `public` に前もって作っておく——`registerEmbeddingSpace` 自体は拡張を
 * 作らない（`runMigrations` の役目、ADR 0057）ため、これが無いと
 * `embedding vector(N)` の型解決が `type "vector" does not exist` で落ちる
 * （このファイルの歯はロックキーの食い違いだけを見たいので、拡張の有無で空振りしない
 * ようにする）。`WITH SCHEMA public` を明示するのは、後で作る「ロール名と同名の
 * スキーマ」が `search_path` の先頭に来ても `vector` 型の解決先を変えないため。
 */
async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 5 });
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  openedPools.push(pool);
  return pool;
}

/** `pool` が接続に使っているロール名（`"$user"` が解決する先そのもの）。 */
async function currentRoleName(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ role: string }>("SELECT current_user AS role");
  return rows[0]!.role;
}

/** 別セッションから advisory lock を握る（テストの「先客」役）。 */
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

describe("schema 未指定 + ロール名と同名のスキーマ: advisory lock キーの食い違い（Issue #779）", () => {
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

  it("runMigrations: ロール名と同名スキーマが在れば、schema 未指定は schema: '<ロール名>' 明示指定と同じキーを使う（互いに待つ）", async () => {
    const pool = await createBlankDatabase(DB_MIGRATE_ROLE_SCHEMA);
    const roleName = await currentRoleName(pool);
    // "$user" の解決先を実際に作る——これが再現条件そのもの（Issue #779 / #757）。
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${roleName}"`);

    const expectedKey = migrationLockKeyFor(roleName);
    // 陽性対照: 明示指定側は既定キーとは別のキーであること（比較に意味があることの確認）。
    expect(expectedKey).not.toBe(MIGRATION_LOCK_KEY);

    const holder = await grabLockFromAnotherSession(DB_MIGRATE_ROLE_SCHEMA, expectedKey);
    try {
      await expect(
        runMigrations(pool, undefined, { lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await holder.release();
    }
  }, 20_000);

  it("runMigrations: ロール名スキーマが無い（current_schema() は public）なら、schema 未指定は今まで通り MIGRATION_LOCK_KEY のまま", async () => {
    const pool = await createBlankDatabase(DB_MIGRATE_PUBLIC);
    const holder = await grabLockFromAnotherSession(DB_MIGRATE_PUBLIC, MIGRATION_LOCK_KEY);
    try {
      await expect(
        runMigrations(pool, undefined, { lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await holder.release();
    }
  }, 20_000);

  it("registerEmbeddingSpace: ロール名と同名スキーマが在れば、schema 未指定は schema: '<ロール名>' 明示指定と同じキーを使う（互いに待つ）", async () => {
    const pool = await createBlankDatabase(DB_VECTOR_ROLE_SCHEMA);
    const roleName = await currentRoleName(pool);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${roleName}"`);
    // registerEmbeddingSpace の FK 先である memories を、"$user" が解決する同じスキーマに
    // 用意しておく（この時点ではまだ誰もロックを握っていないので、この schema 未指定の
    // runMigrations 自体は待たされない）。無いと `CREATE TABLE ... REFERENCES memories(id)`
    // が `relation "memories" does not exist` で落ち、ロックキーの食い違いとは無関係な
    // 理由で空振りする。
    await runMigrations(pool);

    const expectedKey = registerEmbeddingSpaceLockKeyFor(roleName);
    expect(expectedKey).not.toBe(REGISTER_EMBEDDING_SPACE_LOCK_KEY);

    const holder = await grabLockFromAnotherSession(DB_VECTOR_ROLE_SCHEMA, expectedKey);
    try {
      await expect(
        registerEmbeddingSpace(
          pool,
          { provider: "test", model: "role-schema-lock-key-fixture", dimensions: 3 },
          { lockTimeoutMs: 300 },
        ),
      ).rejects.toBeInstanceOf(RegisterEmbeddingSpaceLockTimeoutError);
    } finally {
      await holder.release();
    }
  }, 20_000);

  it("registerEmbeddingSpace: ロール名スキーマが無い（current_schema() は public）なら、schema 未指定は今まで通り REGISTER_EMBEDDING_SPACE_LOCK_KEY のまま", async () => {
    const pool = await createBlankDatabase(DB_VECTOR_PUBLIC);
    const holder = await grabLockFromAnotherSession(
      DB_VECTOR_PUBLIC,
      REGISTER_EMBEDDING_SPACE_LOCK_KEY,
    );
    try {
      await expect(
        registerEmbeddingSpace(
          pool,
          { provider: "test", model: "role-schema-lock-key-fixture-public", dimensions: 3 },
          { lockTimeoutMs: 300 },
        ),
      ).rejects.toBeInstanceOf(RegisterEmbeddingSpaceLockTimeoutError);
    } finally {
      await holder.release();
    }
  }, 20_000);
});
