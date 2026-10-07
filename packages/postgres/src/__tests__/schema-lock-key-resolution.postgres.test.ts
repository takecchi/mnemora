import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
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
import { resolveCurrentSchema } from "../resolve-current-schema.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `role-name-schema-lock-key.postgres.test.ts` が見ていない3つの境界。
 *
 * 1. `schema` を明示したら、`current_schema()` を読まず、その schema の導出キーを使う（明示した schema ごとに別のキーで排他する）。
 *    常に `current_schema()` を読む実装だと、明示した schema の導出キーを先客が握っていても待たなくなる。
 * 2. `current_schema()` を読むのは「`schema` 未指定、かつ `options.lockKey` の上書きも無い」ときだけ。
 *    上書きがあるときや schema を明示したときに、余計な `SELECT current_schema()` を発行しない。
 * 3. `current_schema()` が `NULL`（`search_path` のどのスキーマも無い）なら、未指定のままと同じ扱い（既定の固定キー）になる。
 */

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

async function createBlankDatabase(
  database: string,
  poolOptions: { options?: string } = {},
): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const setup = new Pool({ connectionString: connectionStringFor(database), max: 1 });
  await setup.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  await setup.end();
  const pool = new Pool({
    connectionString: connectionStringFor(database),
    max: 5,
    ...poolOptions,
  });
  openedPools.push(pool);
  return pool;
}

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

function currentSchemaReads(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(([sql]) => {
    const text = typeof sql === "string" ? sql : (sql as { text?: string } | undefined)?.text;
    return text !== undefined && /current_schema\(\)/.test(text);
  }).length;
}

describe("schema 未指定のときだけ current_schema() を読んでロックキーを選ぶ（#924）", () => {
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

  it("runMigrations: schema を明示したら、その schema の導出キーで待つ（current_schema() は読まない）", async () => {
    const database = "mnemora_schema_lock_key_migrate_explicit";
    const pool = await createBlankDatabase(database);
    const schema = "schema_lock_key_app";
    expect(migrationLockKeyFor(schema)).not.toBe(MIGRATION_LOCK_KEY);

    const spy = vi.spyOn(pool, "query");
    const holder = await grabLockFromAnotherSession(database, migrationLockKeyFor(schema));
    try {
      await expect(
        runMigrations(pool, undefined, { schema, lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await holder.release();
    }
    expect(currentSchemaReads(spy)).toBe(0);
  }, 20_000);

  it("runMigrations: options.lockKey を上書きしたら current_schema() を読まず、その上書きのキーで待つ", async () => {
    const database = "mnemora_schema_lock_key_migrate_override";
    const pool = await createBlankDatabase(database);
    const overrideKey = 7_924_001n;

    const spy = vi.spyOn(pool, "query");
    const holder = await grabLockFromAnotherSession(database, overrideKey);
    try {
      await expect(
        runMigrations(pool, undefined, { lockKey: overrideKey, lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await holder.release();
    }
    expect(currentSchemaReads(spy)).toBe(0);
  }, 20_000);

  it("runMigrations: 陽性対照——schema 未指定で上書きも無ければ current_schema() を1回読む", async () => {
    const pool = await createBlankDatabase("mnemora_schema_lock_key_migrate_read");
    const spy = vi.spyOn(pool, "query");
    await runMigrations(pool);
    expect(currentSchemaReads(spy)).toBe(1);
  }, 60_000);

  it("runMigrations: current_schema() が NULL（search_path のどのスキーマも無い）なら、既定の固定キーで待つ", async () => {
    const database = "mnemora_schema_lock_key_migrate_null";
    const pool = await createBlankDatabase(database, {
      options: "-c search_path=schema_lock_key_no_such_schema",
    });
    const { rows } = await pool.query<{ s: string | null }>("SELECT current_schema() AS s");
    expect(rows[0]!.s).toBeNull();

    const holder = await grabLockFromAnotherSession(database, MIGRATION_LOCK_KEY);
    try {
      await expect(runMigrations(pool, undefined, { lockTimeoutMs: 300 })).rejects.toBeInstanceOf(
        MigrationLockTimeoutError,
      );
    } finally {
      await holder.release();
    }
  }, 20_000);

  it("registerEmbeddingSpace: schema を明示したら、その schema の導出キーで待つ（current_schema() は読まない）", async () => {
    const database = "mnemora_schema_lock_key_vector_explicit";
    const pool = await createBlankDatabase(database);
    const schema = "schema_lock_key_app";
    expect(registerEmbeddingSpaceLockKeyFor(schema)).not.toBe(REGISTER_EMBEDDING_SPACE_LOCK_KEY);

    const spy = vi.spyOn(pool, "query");
    const holder = await grabLockFromAnotherSession(
      database,
      registerEmbeddingSpaceLockKeyFor(schema),
    );
    try {
      await expect(
        registerEmbeddingSpace(
          pool,
          { provider: "test", model: "schema-lock-key-explicit", dimensions: 3 },
          { schema, lockTimeoutMs: 300 },
        ),
      ).rejects.toBeInstanceOf(RegisterEmbeddingSpaceLockTimeoutError);
    } finally {
      await holder.release();
    }
    expect(currentSchemaReads(spy)).toBe(0);
  }, 20_000);

  it("registerEmbeddingSpace: options.lockKey を上書きしたら current_schema() を読まず、その上書きのキーで待つ", async () => {
    const database = "mnemora_schema_lock_key_vector_override";
    const pool = await createBlankDatabase(database);
    const overrideKey = 7_924_002n;

    const spy = vi.spyOn(pool, "query");
    const holder = await grabLockFromAnotherSession(database, overrideKey);
    try {
      await expect(
        registerEmbeddingSpace(
          pool,
          { provider: "test", model: "schema-lock-key-override", dimensions: 3 },
          { lockKey: overrideKey, lockTimeoutMs: 300 },
        ),
      ).rejects.toBeInstanceOf(RegisterEmbeddingSpaceLockTimeoutError);
    } finally {
      await holder.release();
    }
    expect(currentSchemaReads(spy)).toBe(0);
  }, 20_000);
});

describe("resolveCurrentSchema（#924）", () => {
  function poolReturning(rows: unknown[]): Pool {
    return { query: async () => ({ rows }) } as unknown as Pool;
  }

  it("current_schema() の値をそのまま返す", async () => {
    expect(await resolveCurrentSchema(poolReturning([{ current_schema: "public" }]))).toBe(
      "public",
    );
    expect(await resolveCurrentSchema(poolReturning([{ current_schema: "app_x" }]))).toBe("app_x");
  });

  it("NULL・行なしは undefined（空文字にしない）", async () => {
    expect(await resolveCurrentSchema(poolReturning([{ current_schema: null }]))).toBeUndefined();
    expect(await resolveCurrentSchema(poolReturning([]))).toBeUndefined();
  });
});
