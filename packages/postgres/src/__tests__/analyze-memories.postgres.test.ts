import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnalyzeMemories, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * 共有の `public.memories` は他のテストファイルと行数・統計が競合しうるので、このファイル専用のスキーマを
 * `runMigrations({ schema })` で用意し、他のテストと行を共有しない。
 */

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const MIGRATE_ENTRY = path.join("src", "bin", "migrate.ts");

const SCHEMA_LIB = "mnemora_analyze_memories_lib";
const SCHEMA_CLI = "mnemora_analyze_memories_cli";
const ALL_SCHEMAS = [SCHEMA_LIB, SCHEMA_CLI] as const;

const ROW_COUNT = 2_000;

async function dropAllSchemas(pool: Pool): Promise<void> {
  for (const schema of ALL_SCHEMAS) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

/**
 * `schema` の `memories` に、必須列だけを埋めた行を `count` 件バルク投入する。
 * 意図的に `ANALYZE` を呼ばない（投入しただけでは統計が動かないことを検査するため）。
 */
async function seedBareMemories(pool: Pool, schema: string, count: number): Promise<void> {
  const ids: string[] = Array.from({ length: count }, () => randomUUID());
  await pool.query(
    `
    INSERT INTO "${schema}".memories (
      id, tenant_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, recorded_at,
      strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
    )
    SELECT
      m.id,
      'analyze-memories-tenant',
      'seed memory ' || m.id::text,
      md5(m.id::text),
      'seed digest ' || m.id::text,
      'llm',
      'imported',
      '{"kind":"imported"}'::jsonb,
      'active',
      '{}'::text[],
      now(),
      1.0,
      720,
      now() + interval '30 days',
      'ready',
      now(),
      now()
    FROM unnest($1::uuid[]) AS m(id)
    `,
    [ids],
  );
}

async function reltuplesFor(pool: Pool, schema: string): Promise<number> {
  const { rows } = await pool.query<{ reltuples: string | null }>(
    `
    SELECT c.reltuples::text AS reltuples
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = 'memories'
    `,
    [schema],
  );
  const value = rows[0]?.reltuples;
  if (value === undefined) {
    throw new Error(`"${schema}".memories が見つからない（マイグレーション未適用？）`);
  }
  return Number(value);
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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

let adminPool: Pool | undefined;

describe("runAnalyzeMemories と --analyze-memories（DB 必須、Issue #234 / ADR 0143）", () => {
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

  it(
    "ライブラリ関数: 行を投入しただけでは reltuples は動かず（0005 の構造的な限界の再現）、" +
      "runAnalyzeMemories を呼んで初めて動く",
    async () => {
      const pool = adminPool!;
      await runMigrations(pool, undefined, { schema: SCHEMA_LIB });

      const beforeInsert = await reltuplesFor(pool, SCHEMA_LIB);
      expect(beforeInsert, "マイグレーション直後、reltuples は 0").toBe(0);

      await seedBareMemories(pool, SCHEMA_LIB, ROW_COUNT);

      const afterInsertBeforeAnalyze = await reltuplesFor(pool, SCHEMA_LIB);
      expect(
        afterInsertBeforeAnalyze,
        `${ROW_COUNT}行投入しても、ANALYZE を呼ぶまで reltuples は動かないこと`,
      ).toBe(0);

      const result = await runAnalyzeMemories(pool, { schema: SCHEMA_LIB });
      expect(result.table).toBe(`"${SCHEMA_LIB}"."memories"`);

      const afterAnalyze = await reltuplesFor(pool, SCHEMA_LIB);
      expect(afterAnalyze, "runAnalyzeMemories の後は reltuples が実際の行数に近づくこと").toBe(
        ROW_COUNT,
      );
    },
  );

  it("schema 省略時は素の table 名（`memories`）を返す", async () => {
    const pool = adminPool!;
    // public は他のテストと共有なので、成功することだけを見て、行数は assert しない。
    const result = await runAnalyzeMemories(pool);
    expect(result.table).toBe("memories");
  });

  it(
    "CLI 配線: `--analyze-memories` を渡すと、マイグレーション適用後に実際に ANALYZE が" +
      "実行され、標準出力にも出る（フラグを渡さなければ起きないことは cli-options.test.ts が" +
      "別途検査する）",
    async () => {
      const pool = adminPool!;

      const first = await runCli(["--schema", SCHEMA_CLI], { DATABASE_URL: requireDatabaseUrl() });
      expect(first.exitCode).toBe(0);
      expect(first.stdout).not.toContain("ANALYZE を実行しました");

      await seedBareMemories(pool, SCHEMA_CLI, ROW_COUNT);
      const beforeAnalyze = await reltuplesFor(pool, SCHEMA_CLI);
      expect(beforeAnalyze, "CLI 経由でも、--analyze-memories 無しでは reltuples は動かない").toBe(
        0,
      );

      const second = await runCli(["--schema", SCHEMA_CLI, "--analyze-memories"], {
        DATABASE_URL: requireDatabaseUrl(),
      });
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("適用対象のマイグレーションはありません");
      expect(second.stdout, "ANALYZE を実行した旨が標準出力に出ること").toContain(
        `ANALYZE を実行しました: "${SCHEMA_CLI}"."memories"`,
      );

      const afterAnalyze = await reltuplesFor(pool, SCHEMA_CLI);
      expect(afterAnalyze, "CLI 経由の --analyze-memories でも reltuples が更新されること").toBe(
        ROW_COUNT,
      );
    },
  );
});
