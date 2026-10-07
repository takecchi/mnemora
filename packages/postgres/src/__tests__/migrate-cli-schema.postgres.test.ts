import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * CLI を実際に子プロセスとして起動し、渡した値が本当に指定した専用スキーマへ DDL を当てるかを、DB のカタログを見て検査する（引数解釈から `runMigrations` 呼び出しまでの配線ごと）。
 * 引数・環境変数の解釈そのものは `./cli-options.test.ts`、DB に触る前に決着する経路は `./migrate-cli-process.test.ts` が測る。
 *
 * `to_regclass('_mnemora_migrations')` のような裸の名前での問い合わせは、`search_path` に乗っている別スキーマ（典型的には `public`）の同名テーブルを拾って「存在する」と誤判定する。
 * そのため常にスキーマ修飾した文字列（`'"schema"."table"'`）を渡し、`IS NOT NULL` で存在の有無だけを見る。
 * 子プロセスの `env` は `process.env` をそのまま渡さない（`buildEnv`）。
 * 各テストが使うスキーマ名は重複しないものを個別に持ち、`afterAll` で `DROP SCHEMA ... CASCADE` する。前回の失敗で残ったスキーマがあっても走れるよう、`beforeAll` でも先に DROP する。
 */

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const MIGRATE_ENTRY = path.join("src", "bin", "migrate.ts");

// CLI 起動は `dist` に依存しない。ビルド前でも走るように `tsx` 経由で `src/bin/migrate.ts` を直接叩く。

const SCHEMA_ARG = "mnemora_cli_arg";
const SCHEMA_ENV = "mnemora_cli_env";
const SCHEMA_WINNER = "mnemora_cli_winner";
const SCHEMA_LOSER = "mnemora_cli_loser";
const SCHEMA_EXT = "mnemora_cli_ext";
const SCHEMA_IDEMPOTENT = "mnemora_cli_idempotent";

const ALL_SCHEMAS = [
  SCHEMA_ARG,
  SCHEMA_ENV,
  SCHEMA_WINNER,
  SCHEMA_LOSER,
  SCHEMA_EXT,
  SCHEMA_IDEMPOTENT,
] as const;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `overrides` に無いものはこの子プロセスの環境に一切存在しない（`PATH` だけは `tsx` の shebang 解決に必須なので常に含める）。 */
function buildEnv(overrides: Readonly<Record<string, string>>): Record<string, string> {
  return { PATH: process.env.PATH ?? "", ...overrides };
}

async function runCli(
  args: readonly string[],
  overrides: Readonly<Record<string, string>>,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [MIGRATE_ENTRY, ...args], {
      cwd: PACKAGE_ROOT,
      env: buildEnv(overrides),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof failure.code === "number" ? failure.code : 1;
    return { exitCode: code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function qualifiedName(schema: string, name: string): string {
  return `"${schema}"."${name}"`;
}

/** `qualifiedName` で作った `'"schema"."name"'` を渡す想定。パラメータとして渡すので SQL 文字列へ埋め込まない。 */
async function regclassExists(pool: Pool, qualified: string): Promise<boolean> {
  const { rows } = await pool.query<{ oid: string | null }>("SELECT to_regclass($1) AS oid", [
    qualified,
  ]);
  return rows[0]!.oid !== null;
}

let adminPool: Pool | undefined;

/** `adminPool` が無ければ何もしない。`beforeAll` が先に落ちた場合に、`afterAll` が二次的な `TypeError` を投げて本当の原因を覆い隠さないため。 */
async function dropAllSchemas(): Promise<void> {
  if (!adminPool) {
    return;
  }
  for (const schema of ALL_SCHEMAS) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

function pool(): Pool {
  return adminPool!;
}

describe("mnemora-postgres-migrate（子プロセス起動、専用スキーマへの適用、DB 必須）", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: requireDatabaseUrl(), max: 3 });
    await dropAllSchemas();
  });

  afterAll(async () => {
    await dropAllSchemas();
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("--schema <name> で当たる: 指定したスキーマに台帳とドメインテーブルが出来る", async () => {
    const result = await runCli(["--schema", SCHEMA_ARG], {
      DATABASE_URL: requireDatabaseUrl(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout, "適用したマイグレーション名が出ること").toContain(
      "適用したマイグレーション",
    );

    expect(
      await regclassExists(pool(), qualifiedName(SCHEMA_ARG, "_mnemora_migrations")),
      `${SCHEMA_ARG}._mnemora_migrations が存在すること`,
    ).toBe(true);
    expect(
      await regclassExists(pool(), qualifiedName(SCHEMA_ARG, "memories")),
      `${SCHEMA_ARG}.memories が存在すること`,
    ).toBe(true);
  });

  it("MNEMORA_SCHEMA でも当たる: 引数無し・環境変数だけでも同じスキーマに出来る", async () => {
    const result = await runCli([], {
      DATABASE_URL: requireDatabaseUrl(),
      MNEMORA_SCHEMA: SCHEMA_ENV,
    });

    expect(result.exitCode).toBe(0);
    expect(
      await regclassExists(pool(), qualifiedName(SCHEMA_ENV, "_mnemora_migrations")),
      `${SCHEMA_ENV}._mnemora_migrations が存在すること`,
    ).toBe(true);
    expect(
      await regclassExists(pool(), qualifiedName(SCHEMA_ENV, "memories")),
      `${SCHEMA_ENV}.memories が存在すること`,
    ).toBe(true);
  });

  it(
    "優先順位（引数 > 環境変数）をふるまいで測る: " +
      "MNEMORA_SCHEMA=loser と --schema winner を同時に渡すと winner にだけ当たり、" +
      "loser のスキーマ自体が作られない",
    async () => {
      const result = await runCli(["--schema", SCHEMA_WINNER], {
        DATABASE_URL: requireDatabaseUrl(),
        MNEMORA_SCHEMA: SCHEMA_LOSER,
      });

      expect(result.exitCode).toBe(0);

      expect(
        await regclassExists(pool(), qualifiedName(SCHEMA_WINNER, "_mnemora_migrations")),
        `${SCHEMA_WINNER}._mnemora_migrations が存在すること（引数が勝つ）`,
      ).toBe(true);
      expect(
        await regclassExists(pool(), qualifiedName(SCHEMA_WINNER, "memories")),
        `${SCHEMA_WINNER}.memories が存在すること`,
      ).toBe(true);

      // 「パーサの戻り値」ではなく「どちらのスキーマに実際に当たったか」で測る。loser 側は `_mnemora_migrations` どころかスキーマ自体が作られていないはず。
      const { rows } = await pool().query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_namespace WHERE nspname = $1",
        [SCHEMA_LOSER],
      );
      expect(rows[0]!.n, `${SCHEMA_LOSER} スキーマ自体が作られていないこと`).toBe("0");
    },
  );

  it("--extension-schema が効く: public を明示しても指定スキーマへ当たる", async () => {
    const result = await runCli(["--schema", SCHEMA_EXT, "--extension-schema", "public"], {
      DATABASE_URL: requireDatabaseUrl(),
    });

    expect(result.exitCode).toBe(0);
    expect(
      await regclassExists(pool(), qualifiedName(SCHEMA_EXT, "_mnemora_migrations")),
      `${SCHEMA_EXT}._mnemora_migrations が存在すること`,
    ).toBe(true);
    expect(
      await regclassExists(pool(), qualifiedName(SCHEMA_EXT, "memories")),
      `${SCHEMA_EXT}.memories が存在すること`,
    ).toBe(true);
  });

  it("冪等: 同じスキーマへ2回続けて起動しても2回目も終了コード0で、適用対象が無い旨が出る", async () => {
    const env = { DATABASE_URL: requireDatabaseUrl() };

    const first = await runCli(["--schema", SCHEMA_IDEMPOTENT], env);
    expect(first.exitCode).toBe(0);

    const second = await runCli(["--schema", SCHEMA_IDEMPOTENT], env);
    expect(second.exitCode).toBe(0);
    expect(
      second.stdout,
      "2回目は「適用対象のマイグレーションはありません」旨が出ること",
    ).toContain("適用対象のマイグレーションはありません");

    expect(
      await regclassExists(pool(), qualifiedName(SCHEMA_IDEMPOTENT, "memories")),
      `${SCHEMA_IDEMPOTENT}.memories が存在すること`,
    ).toBe(true);
  });
});
