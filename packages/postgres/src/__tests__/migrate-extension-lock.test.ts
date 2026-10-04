import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_LOCK_KEY, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `runMigrations` の共有の拡張ロック（`EXTENSION_LOCK_KEY`、#1220）まわりの約束:
 * - 拡張ロックを待つために敷く `lock_timeout` は、待ち終えたら戻し、本体には効かせない。
 *   戻す先は、利用者がロールに設定した値（`RESET`）。
 * - 取った拡張ロックは、終わった後に手放す（pool を持ち続けても、別のセッションが取れる）。
 * - 拡張ロックを持つ最中にロックの接続が切れたら、元の失敗で reject し、ロックの返却の失敗で
 *   上書きしない。
 *
 * `pg_stat_activity`・`pg_terminate_backend`・`CREATE ROLE` を使うので直列の群に置く
 * （`vitest.config.mts`）。advisory lock は DB ごとなので、専用の DB を作って他のファイルと分ける。
 */

const DB = "mnemora_ext_lock_teeth";
const ROLE = "mnemora_ext_lock_teeth_role";
const ROLE_PASSWORD = "mnemora-ext-lock-teeth-role-password";

function connectionStringFor(credentials?: { user: string; password: string }): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${DB}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

function dirWith(name: string, sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemora-ext-lock-teeth-"));
  writeFileSync(join(dir, name), sql);
  return dir;
}

let admin: Pool;
let pool: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
  await dropTempDatabase(admin, DB);
  await admin.query(`CREATE DATABASE ${DB}`);
  pool = new Pool({ connectionString: connectionStringFor(), max: 4 });
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
});

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await dropTempDatabase(admin, DB);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
    await admin.end();
  }
});

/** `DB` の中で、`like` に当たる問い合わせを流しているバックエンドの pid が現れるまで待つ。 */
async function waitForBackend(like: string, onlyWaitingOnLock = false): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = $1 AND query ILIKE $2 AND pid <> pg_backend_pid()
          AND ($3::boolean IS FALSE OR wait_event_type = 'Lock')`,
      [DB, like, onlyWaitingOnLock],
    );
    if (rows.length > 0) return rows[0]!.pid;
    await sleep(50);
  }
  throw new Error(`waitForBackend: ${like} を流すバックエンドが現れなかった`);
}

describe("runMigrations: 共有の拡張ロック（EXTENSION_LOCK_KEY）", () => {
  it("拡張ロックを取る経路でも、本体が lockTimeoutMs より長く別のロックを待って時間切れにならない", async () => {
    const heldKey = 7_190_158_676_462_702_001n;
    const dir = dirWith(
      "9501_ext_lock_timeout_scope.sql",
      `CREATE EXTENSION IF NOT EXISTS vector;\nSELECT pg_advisory_xact_lock(${heldKey.toString()});`,
    );
    const holder = new Client({ connectionString: connectionStringFor() });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [heldKey.toString()]);
      const outcome = runMigrations(pool, dir, { lockTimeoutMs: 300 }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      // 本体が `heldKey` を lockTimeoutMs（300ms）より長く待つようにしてから手放す。
      await sleep(1_000);
      await holder.query("SELECT pg_advisory_unlock($1)", [heldKey.toString()]);
      const settled = await outcome;
      expect(settled).toEqual({
        result: expect.objectContaining({ applied: [expect.any(String)] }),
      });
    } finally {
      await holder.end();
    }
  }, 20_000);

  it.each([
    ["ファイルの適用", undefined],
    ["拡張を作る段（schema 指定）", "ext_lock_release_schema"],
  ])(
    "%s の後は、pool を持ち続けたままでも別のセッションが拡張ロックを取れる",
    async (_label, schema) => {
      const dir = dirWith(
        schema === undefined ? "9502_ext_lock_release.sql" : "9503_ext_lock_release_schema.sql",
        schema === undefined ? "CREATE EXTENSION IF NOT EXISTS vector;\nSELECT 1;" : "SELECT 1;",
      );
      await runMigrations(pool, dir, { ...(schema === undefined ? {} : { schema }) });

      const other = new Client({ connectionString: connectionStringFor() });
      await other.connect();
      try {
        const { rows } = await other.query<{ got: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS got",
          [EXTENSION_LOCK_KEY.toString()],
        );
        expect(rows[0]!.got).toBe(true);
        await other.query("SELECT pg_advisory_unlock($1)", [EXTENSION_LOCK_KEY.toString()]);
      } finally {
        await other.end();
      }
    },
    20_000,
  );

  it("拡張ロックを持つファイルの適用中にロックの接続が切れると、そのファイルの失敗で reject する", async () => {
    const dir = dirWith(
      "9504_ext_lock_connloss_file.sql",
      "CREATE EXTENSION IF NOT EXISTS vector;\nSELECT pg_sleep(7.25);",
    );
    const outcome = runMigrations(pool, dir).then(
      () => new Error("resolved"),
      (error: unknown) => error as Error,
    );
    const pid = await waitForBackend("%pg_sleep(7.25)%");
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    // ロックの返却の失敗が、適用していたファイルの失敗を上書きしない。
    expect((await outcome).message).toMatch(/^migration 9504_ext_lock_connloss_file\.sql failed: /);
  }, 20_000);

  it("拡張を作っている最中にロックの接続が切れると、その元の失敗で reject する", async () => {
    const dir = dirWith("9505_ext_lock_connloss_create.sql", "SELECT 1;");
    // `pg_extension` を排他で握ると、`CREATE EXTENSION IF NOT EXISTS`（存在の確認）がそこで待つ。
    const holder = new Client({ connectionString: connectionStringFor() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE pg_extension IN ACCESS EXCLUSIVE MODE");
      const outcome = runMigrations(pool, dir, { schema: "ext_lock_connloss_create" }).then(
        () => new Error("resolved"),
        (error: unknown) => error as Error,
      );
      const pid = await waitForBackend("CREATE EXTENSION IF NOT EXISTS%", true);
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      // ロックの返却の失敗が、拡張の作成の失敗を上書きしない。
      expect((await outcome).message).toMatch(
        /terminating connection due to administrator command/,
      );
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  }, 20_000);

  describe("利用者がロールに設定した lock_timeout", () => {
    beforeAll(async () => {
      await admin.query(
        `DO $do$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
             CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}';
           END IF;
         END $do$;`,
      );
      await admin.query(`ALTER ROLE ${ROLE} PASSWORD '${ROLE_PASSWORD}'`);
      await admin.query(`ALTER ROLE ${ROLE} SET lock_timeout = '5s'`);
      await admin.query(`GRANT CONNECT ON DATABASE ${DB} TO ${ROLE}`);
      await pool.query(`GRANT ALL ON SCHEMA public TO ${ROLE}`);
    });

    it.each([
      ["ロックを待った後", "SELECT 1;"],
      ["拡張ロックを待った後", "CREATE EXTENSION IF NOT EXISTS vector;"],
    ])(
      "%s も、本体の中ではロールに設定した値（5s）のまま",
      async (label, head) => {
        const name = `9506_role_lock_timeout_${label === "ロックを待った後" ? "a" : "b"}.sql`;
        const dir = dirWith(
          name,
          `${head}\nDO $$ BEGIN
           IF current_setting('lock_timeout') <> '5s' THEN
             RAISE EXCEPTION 'lock_timeout is %', current_setting('lock_timeout');
           END IF;
         END $$;`,
        );
        // 台帳は管理ロールが作っていることがあるので、このロールに触らせる。
        await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
        const rolePool = new Pool({
          connectionString: connectionStringFor({ user: ROLE, password: ROLE_PASSWORD }),
          max: 2,
        });
        try {
          const result = await runMigrations(rolePool, dir);
          expect(result.applied).toEqual([name]);
        } finally {
          await rolePool.end();
        }
      },
      20_000,
    );
  });
});
