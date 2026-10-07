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
 * `pg_stat_activity`・`pg_terminate_backend`・`CREATE ROLE` を使うので直列の群に置く（`vitest.config.mts`）。advisory lock は DB ごとなので、専用の DB を作って他のファイルと分ける。
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

/**
 * `DB` の中で、`like` に当たる問い合わせを流しているバックエンドの pid が現れるまで待つ。`outcome`（待っている相手の処理）を渡すと、それが先に終わったら上限まで回らずにその元のエラー文で落ち、
 * 現れないまま打ち切ったときは、`outcome` がまだ終わっていないことと `pg_stat_activity` の行をエラー文に載せる。
 */
async function waitForBackend(
  like: string,
  options: { onlyWaitingOnLock?: boolean; outcome?: Promise<unknown>; attempts?: number } = {},
): Promise<number> {
  const { onlyWaitingOnLock = false, outcome, attempts = 100 } = options;
  let settled: string | undefined;
  outcome?.then(
    () => {
      settled = "resolve した";
    },
    (error: unknown) => {
      settled = `reject した: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (settled !== undefined) {
      throw new Error(
        `waitForBackend: ${like} が現れる前に、待っていた処理が先に終わった（${settled}）`,
      );
    }
    const { rows } = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = $1 AND query ILIKE $2 AND pid <> pg_backend_pid()
          AND ($3::boolean IS FALSE OR wait_event_type = 'Lock')`,
      [DB, like, onlyWaitingOnLock],
    );
    if (rows.length > 0) return rows[0]!.pid;
    await sleep(50);
  }
  const { rows: activity } = await admin.query(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 200) AS query
       FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY pid`,
    [DB],
  );
  const outcomeState =
    outcome === undefined ? "渡されていない" : (settled ?? "待っていた処理はまだ終わっていない");
  throw new Error(
    `waitForBackend: ${like} を流すバックエンドが現れなかった（${attempts}回）。` +
      `outcome: ${outcomeState}。pg_stat_activity: ${JSON.stringify(activity)}`,
  );
}

/** `DB` の relcache の init file（`base/<dboid>/pg_internal.init`）が在るか。 */
async function relcacheInitFileExists(): Promise<boolean> {
  const { rows } = await admin.query<{ present: boolean }>(
    `SELECT (pg_stat_file('base/' || oid || '/pg_internal.init', true)).size IS NOT NULL AS present
       FROM pg_database WHERE datname = $1`,
    [DB],
  );
  return rows[0]!.present;
}

/**
 * `client` の接続のまま、init file を確実に消させる。`pg_class` の行を必ず更新する、効果の無い GRANT を流す
 * （PUBLIC の SELECT は既定で付いている）。VACUUM や統計の更新は、変化が無いと消えないので使わない。
 */
async function invalidateRelcacheInitFile(client: Client): Promise<void> {
  await client.query("GRANT SELECT ON pg_class TO PUBLIC");
}

/**
 * `pg_extension` を排他で握る接続を返す。`CREATE EXTENSION IF NOT EXISTS`（存在の確認）は、これが
 * ROLLBACK されるまでそこで待つ。`prepare` は、握る前に holder 自身の接続で流す。
 *
 * 握る前に `pool` の接続を1本借りて返す。握った後に新しく開く接続は、起動の途中で `pg_extension` を
 * 開いて止まり（relcache の init file が無いとき）、`pg_stat_activity` に `query` を持つ行として現れない。
 */
async function holdPgExtensionExclusively(
  pool: Pool,
  prepare?: (holder: Client) => Promise<void>,
): Promise<Client> {
  (await pool.connect()).release();
  const holder = new Client({ connectionString: connectionStringFor() });
  await holder.connect();
  try {
    await prepare?.(holder);
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE pg_extension IN ACCESS EXCLUSIVE MODE");
    return holder;
  } catch (error) {
    await holder.end().catch(() => {});
    throw error;
  }
}

describe("runMigrations: 共有の拡張ロック（EXTENSION_LOCK_KEY）", () => {
  // 共有の拡張ロックは「拡張を作る未適用のファイルがあり、`extensionMode: "create"`」のときだけ取る。別の接続が拡張ロックを握っていても、取らない経路は待たされない。取る経路になると、握られている間 `lockTimeoutMs` で時間切れになる。
  async function holdExtensionLock(): Promise<Client> {
    const holder = new Client({ connectionString: connectionStringFor() });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [EXTENSION_LOCK_KEY.toString()]);
    return holder;
  }

  it("別の接続が拡張ロックを握っていても、CREATE EXTENSION 行の無い未適用ファイルの適用は待たされない", async () => {
    const dir = dirWith(
      "9511_ext_lock_scope_first.sql",
      "CREATE EXTENSION IF NOT EXISTS vector;\nSELECT 1;",
    );
    await runMigrations(pool, dir); // 1本目（拡張を作る行を含む）を適用して台帳に載せる
    writeFileSync(join(dir, "9512_ext_lock_scope_no_extension.sql"), "SELECT 1;");
    const holder = await holdExtensionLock();
    try {
      const result = await runMigrations(pool, dir, { lockTimeoutMs: 300 });
      expect(result.applied).toEqual(["9512_ext_lock_scope_no_extension.sql"]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [EXTENSION_LOCK_KEY.toString()]);
      await holder.end();
    }
  }, 20_000);

  it("陽性対照: CREATE EXTENSION 行を含む未適用ファイルは、拡張ロックが握られている間 lockTimeoutMs で時間切れになる", async () => {
    const dir = dirWith(
      "9513_ext_lock_scope_control.sql",
      "CREATE EXTENSION IF NOT EXISTS vector;\nSELECT 1;",
    );
    const holder = await holdExtensionLock();
    try {
      await expect(runMigrations(pool, dir, { lockTimeoutMs: 300 })).rejects.toThrow();
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [EXTENSION_LOCK_KEY.toString()]);
      await holder.end();
    }
  }, 20_000);

  it('extensionMode: "verify" は、別の接続が拡張ロックを握っていても、拡張を作る行を含むファイルを待たずに適用する', async () => {
    const dir = dirWith(
      "9514_ext_lock_verify.sql",
      "CREATE EXTENSION IF NOT EXISTS vector;\nSELECT 1;",
    );
    for (const ext of ["vector", "btree_gin", "pgcrypto"]) {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    const holder = await holdExtensionLock();
    try {
      const result = await runMigrations(pool, dir, {
        extensionMode: "verify",
        lockTimeoutMs: 300,
      });
      expect(result.applied).toEqual(["9514_ext_lock_verify.sql"]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [EXTENSION_LOCK_KEY.toString()]);
      await holder.end();
    }
  }, 20_000);

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
    const run = runMigrations(pool, dir);
    const outcome = run.then(
      () => new Error("resolved"),
      (error: unknown) => error as Error,
    );
    const pid = await waitForBackend("%pg_sleep(7.25)%", { outcome: run });
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    expect((await outcome).message).toMatch(/^migration 9504_ext_lock_connloss_file\.sql failed: /);
  }, 20_000);

  it("拡張を作っている最中にロックの接続が切れると、その元の失敗で reject する", async () => {
    const dir = dirWith("9505_ext_lock_connloss_create.sql", "SELECT 1;");
    const holder = await holdPgExtensionExclusively(pool);
    try {
      const run = runMigrations(pool, dir, { schema: "ext_lock_connloss_create" });
      const outcome = run.then(
        () => new Error("resolved"),
        (error: unknown) => error as Error,
      );
      const pid = await waitForBackend("CREATE EXTENSION IF NOT EXISTS%", {
        onlyWaitingOnLock: true,
        outcome: run,
      });
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      expect((await outcome).message).toMatch(
        /terminating connection due to administrator command/,
      );
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  }, 20_000);

  it("pool が冷えていて relcache の init file も無いとき、拡張を作る段の Lock 待ちに着き、その元の失敗で reject する", async () => {
    const dir = dirWith("9507_ext_lock_cold_pool.sql", "SELECT 1;");
    const coldPool = new Pool({ connectionString: connectionStringFor(), max: 4 });
    const holder = await holdPgExtensionExclusively(coldPool, async (client) => {
      await invalidateRelcacheInitFile(client);
      expect(
        await relcacheInitFileExists(),
        "前提が崩れた: init file が消えていない（陽性対照）",
      ).toBe(false);
    });
    try {
      const run = runMigrations(coldPool, dir, { schema: "ext_lock_cold_pool" });
      const outcome = run.then(
        () => new Error("resolved"),
        (error: unknown) => error as Error,
      );
      const pid = await waitForBackend("CREATE EXTENSION IF NOT EXISTS%", {
        onlyWaitingOnLock: true,
        outcome: run,
      });
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      expect((await outcome).message).toMatch(
        /terminating connection due to administrator command/,
      );
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
      await coldPool.end();
    }
  }, 20_000);

  describe("waitForBackend の診断（Issue #1825）", () => {
    it("待っている間に runMigrations が先に失敗したら、待ちの打ち切りではなく、その元のエラー文で落ちる", async () => {
      const run = runMigrations(pool, join(tmpdir(), "mnemora-ext-lock-teeth-does-not-exist"));
      run.catch(() => {});
      const startedAt = Date.now();
      const error = await waitForBackend("CREATE EXTENSION IF NOT EXISTS%", {
        onlyWaitingOnLock: true,
        outcome: run,
      }).then(
        () => new Error("resolved"),
        (e: unknown) => e as Error,
      );
      const original = await run.then(
        () => new Error("resolved"),
        (e: unknown) => e as Error,
      );
      expect(error.message).toContain("先に終わった");
      expect(error.message).toContain(original.message);
      expect(error.message).not.toContain("現れなかった");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    }, 20_000);

    it("現れないまま打ち切ったときは、pg_stat_activity の行と、待っていた処理がまだ終わっていないことをエラー文に載せる", async () => {
      const error = await waitForBackend("%mnemora-ext-lock-teeth-never-runs%", {
        outcome: new Promise<never>(() => {}),
        attempts: 2,
      }).then(
        () => new Error("resolved"),
        (e: unknown) => e as Error,
      );
      expect(error.message).toContain("現れなかった");
      expect(error.message).toContain("待っていた処理はまだ終わっていない");
      expect(error.message).toContain("pg_stat_activity");
    }, 20_000);
  });

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
