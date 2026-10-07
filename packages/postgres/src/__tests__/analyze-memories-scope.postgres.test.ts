import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnalyzeMemories, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const MIGRATE_ENTRY = path.join("src", "bin", "migrate.ts");

const SCHEMA_TARGET = "mnemora_analyze_scope_target";
const SCHEMA_OTHER = "mnemora_analyze_scope_other";
const SCHEMA_FRESH = "mnemora_analyze_scope_fresh";
const SCHEMA_ENV = "mnemora_analyze_scope_env";
const SCHEMA_LOCKED = "mnemora_analyze_scope_locked";
const SCHEMA_BROKEN = "mnemora_analyze_scope_broken";
const ALL_SCHEMAS = [
  SCHEMA_TARGET,
  SCHEMA_OTHER,
  SCHEMA_FRESH,
  SCHEMA_ENV,
  SCHEMA_LOCKED,
  SCHEMA_BROKEN,
] as const;

const ROW_COUNT = 2_000;
const ANALYZED_MESSAGE = "ANALYZE を実行しました";

async function dropAllSchemas(pool: Pool): Promise<void> {
  for (const schema of ALL_SCHEMAS) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

// autovacuum が投入の途中で ANALYZE すると、「この呼び出しは統計を動かさない」を測れなくなる。
async function disableAutovacuum(pool: Pool, schema: string, table: string): Promise<void> {
  await pool.query(`ALTER TABLE "${schema}".${table} SET (autovacuum_enabled = false)`);
}

async function seedMemories(pool: Pool, schema: string): Promise<void> {
  await disableAutovacuum(pool, schema, "memories");
  const ids: string[] = Array.from({ length: ROW_COUNT }, () => randomUUID());
  await pool.query(
    `
    INSERT INTO "${schema}".memories (
      id, tenant_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, recorded_at,
      strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
    )
    SELECT
      m.id, 'analyze-scope-tenant', 'seed memory ' || m.id::text, md5(m.id::text),
      'seed digest ' || m.id::text, 'llm', 'imported', '{"kind":"imported"}'::jsonb,
      'active', '{}'::text[], now(), 1.0, 720, now() + interval '30 days', 'ready', now(), now()
    FROM unnest($1::uuid[]) AS m(id)
    `,
    [ids],
  );
}

async function seedMemoryEvents(pool: Pool, schema: string): Promise<void> {
  await disableAutovacuum(pool, schema, "memory_events");
  await pool.query(
    `
    INSERT INTO "${schema}".memory_events (tenant_id, kind, actor)
    SELECT 'analyze-scope-tenant', 'created', '{"type":"system"}'::jsonb
      FROM generate_series(1, $1::int)
    `,
    [ROW_COUNT],
  );
}

async function reltuplesByTable(pool: Pool, schema: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ relname: string; reltuples: string }>(
    `
    SELECT c.relname, c.reltuples::text AS reltuples
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'
    `,
    [schema],
  );
  return Object.fromEntries(rows.map((row) => [row.relname, Number(row.reltuples)]));
}

async function memoriesReltuples(pool: Pool, schema: string): Promise<number> {
  const byTable = await reltuplesByTable(pool, schema);
  const value = byTable["memories"];
  if (value === undefined) {
    throw new Error(`"${schema}".memories が見つからない`);
  }
  return value;
}

function withoutMemories(byTable: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(byTable).filter(([name]) => name !== "memories"));
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [MIGRATE_ENTRY, ...args], {
      cwd: PACKAGE_ROOT,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: requireDatabaseUrl(), ...overrides },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof failure.code === "number" ? failure.code : 1;
    return { exitCode: code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** `schema.memories` の統計を更新しようとする ANALYZE を待たせ続ける（`statement_timeout` で打ち切らせるため）。 */
async function withMemoriesLocked<T>(schema: string, body: () => Promise<T>): Promise<T> {
  const holder = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  const client = await holder.connect();
  try {
    await client.query("BEGIN");
    await client.query(`LOCK TABLE "${schema}".memories IN SHARE UPDATE EXCLUSIVE MODE`);
    return await body();
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await holder.end();
  }
}

let adminPool: Pool | undefined;

describe("runAnalyzeMemories と --analyze-memories の範囲と失敗（DB 必須）", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: requireDatabaseUrl(), max: 3 });
    await dropAllSchemas(adminPool);
  });

  afterAll(async () => {
    if (adminPool) {
      await dropAllSchemas(adminPool);
      await adminPool.end();
    }
  });

  it("runAnalyzeMemories は指定したスキーマの memories だけを分析し、同じスキーマの別の表・別スキーマの memories の統計は動かさない", async () => {
    const pool = adminPool!;
    await runMigrations(pool, undefined, { schema: SCHEMA_TARGET });
    await runMigrations(pool, undefined, { schema: SCHEMA_OTHER });
    await seedMemories(pool, SCHEMA_TARGET);
    await seedMemoryEvents(pool, SCHEMA_TARGET);
    await seedMemories(pool, SCHEMA_OTHER);
    const targetBefore = await reltuplesByTable(pool, SCHEMA_TARGET);
    const otherBefore = await reltuplesByTable(pool, SCHEMA_OTHER);

    await runAnalyzeMemories(pool, { schema: SCHEMA_TARGET });

    expect(await memoriesReltuples(pool, SCHEMA_TARGET)).toBe(ROW_COUNT);
    expect(withoutMemories(await reltuplesByTable(pool, SCHEMA_TARGET))).toEqual(
      withoutMemories(targetBefore),
    );
    expect(await reltuplesByTable(pool, SCHEMA_OTHER)).toEqual(otherBefore);
  });

  it("runAnalyzeMemories は ANALYZE が失敗したら握りつぶさず reject する", async () => {
    const pool = adminPool!;
    await runMigrations(pool, undefined, { schema: SCHEMA_LOCKED });
    const impatient = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 1,
      options: "-c statement_timeout=1000",
    });
    try {
      await withMemoriesLocked(SCHEMA_LOCKED, async () => {
        await expect(runAnalyzeMemories(impatient, { schema: SCHEMA_LOCKED })).rejects.toThrow(
          /statement timeout/,
        );
      });
    } finally {
      await impatient.end();
    }
  });

  it("CLI: --analyze-memories を付けずに seed 済みのスキーマへ再実行しても、統計は動かず ANALYZE の報告も出ない", async () => {
    const pool = adminPool!;
    await runMigrations(pool, undefined, { schema: SCHEMA_FRESH });
    await seedMemories(pool, SCHEMA_FRESH);

    const result = await runCli(["--schema", SCHEMA_FRESH]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(ANALYZED_MESSAGE);
    expect(await memoriesReltuples(pool, SCHEMA_FRESH)).toBe(0);
  });

  it("CLI: 新しいスキーマへ --analyze-memories を付けて1回で実行すると、マイグレーションの適用の後に ANALYZE が走る", async () => {
    const pool = adminPool!;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_FRESH}" CASCADE`);

    const result = await runCli(["--schema", SCHEMA_FRESH, "--analyze-memories"]);

    expect(result.exitCode).toBe(0);
    const appliedAt = result.stdout.indexOf("適用したマイグレーション");
    const analyzedAt = result.stdout.indexOf(ANALYZED_MESSAGE);
    expect(appliedAt).toBeGreaterThanOrEqual(0);
    expect(analyzedAt).toBeGreaterThan(appliedAt);
    expect(result.stdout).toContain(`"${SCHEMA_FRESH}"."memories"`);
  });

  it("CLI: --analyze-memories は VACUUM までは行わない", async () => {
    const pool = adminPool!;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_FRESH}" CASCADE`);

    const result = await runCli(["--schema", SCHEMA_FRESH, "--analyze-memories"]);

    expect(result.exitCode).toBe(0);
    const { rows } = await pool.query<{ last_analyze: Date | null; last_vacuum: Date | null }>(
      `SELECT last_analyze, last_vacuum FROM pg_stat_user_tables WHERE schemaname = $1 AND relname = 'memories'`,
      [SCHEMA_FRESH],
    );
    expect(rows[0]?.last_analyze).not.toBeNull();
    expect(rows[0]?.last_vacuum).toBeNull();
  });

  it.each([
    ["1", true],
    ["0", false],
  ])(
    "CLI: 環境変数 MNEMORA_ANALYZE_MEMORIES=%s のとき、ANALYZE を実行するのは %s",
    async (value, analyzes) => {
      const pool = adminPool!;
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_ENV}" CASCADE`);
      await runMigrations(pool, undefined, { schema: SCHEMA_ENV });
      await seedMemories(pool, SCHEMA_ENV);

      const result = await runCli(["--schema", SCHEMA_ENV], { MNEMORA_ANALYZE_MEMORIES: value });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes(ANALYZED_MESSAGE)).toBe(analyzes);
      expect(await memoriesReltuples(pool, SCHEMA_ENV)).toBe(analyzes ? ROW_COUNT : 0);
    },
  );

  it("CLI: マイグレーションが失敗したら ANALYZE は走らず、失敗の原因が標準エラーに出て終了コード 1 になる", async () => {
    const result = await runCli(
      [
        "--schema",
        SCHEMA_BROKEN,
        "--extension-schema",
        SCHEMA_OTHER,
        "--extension-mode",
        "verify",
        "--analyze-memories",
      ],
      {},
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(ANALYZED_MESSAGE);
    expect(result.stderr).toContain('type "vector" does not exist');
  });

  it("CLI: マイグレーションの後の ANALYZE が失敗したら、成功とは報告せず終了コード 1 になる", async () => {
    const pool = adminPool!;
    await runMigrations(pool, undefined, { schema: SCHEMA_LOCKED });

    const result = await withMemoriesLocked(SCHEMA_LOCKED, () =>
      runCli(["--schema", SCHEMA_LOCKED, "--analyze-memories"], {
        PGOPTIONS: "-c statement_timeout=1500",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("適用対象のマイグレーションはありません");
    expect(result.stdout).not.toContain(ANALYZED_MESSAGE);
    expect(result.stderr).toContain("statement timeout");
  });
});
