import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

/** 専用スキーマ（このファイル専用の名前）の中で走らせ、`public` の台帳（他のテストが共有する）には触れない。 */

const SCHEMA = "mnemora_ledger_drift_warning";
const ALL_FILES = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
const FILE_0011 = "0011_memory_events_kind_restored.sql";
const LAST_FILE = ALL_FILES[ALL_FILES.length - 1]!;

let pool: Pool;
let warnSpy: ReturnType<typeof vi.spyOn>;

function warnings(): string[] {
  return warnSpy.mock.calls
    .map((args: unknown[]) => args[0])
    .filter((m: unknown): m is string => typeof m === "string");
}

async function kindCheckDefinition(): Promise<string> {
  const { rows } = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = $1 AND rel.relname = 'memory_events'
        AND con.conname = 'memory_events_kind_check'`,
    [SCHEMA],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.def;
}

describe("runMigrations: 台帳と手元のファイルのずれを警告して続行する（S-1・S-3）", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireDatabaseUrl() });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.end();
  });

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  async function freshSchemaFullyMigrated(): Promise<void> {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const first = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });
    expect(first.applied).toEqual(ALL_FILES);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  it("ずれが無い通常の再実行では警告が出ない", async () => {
    await freshSchemaFullyMigrated();
    const again = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });
    expect(again.applied).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it("(a) 台帳から 0011 の行だけを消して再実行すると警告が出る。0011 は当たり直され、'unsuperseded' が kind_check から消える", async () => {
    await freshSchemaFullyMigrated();
    expect(await kindCheckDefinition()).toContain("unsuperseded");
    await pool.query(`DELETE FROM "${SCHEMA}"._mnemora_migrations WHERE name = $1`, [FILE_0011]);

    const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });

    expect(result.applied).toEqual([FILE_0011]);
    expect(await kindCheckDefinition()).not.toContain("unsuperseded");
    const w = warnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("[@mnemora/postgres]");
    expect(w[0]).toContain(FILE_0011);
    expect(w[0]).toContain(LAST_FILE);
    expect(w[0]).toContain("巻き戻");
  });

  it("(b) 台帳に手元に無い名前があると警告が出る。適用は何も変わらない", async () => {
    await freshSchemaFullyMigrated();
    const unknown = "9999_from_a_newer_version.sql";
    await pool.query(`INSERT INTO "${SCHEMA}"._mnemora_migrations (name) VALUES ($1)`, [unknown]);
    const before = await kindCheckDefinition();

    const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });

    expect(result.applied).toEqual([]);
    expect(await kindCheckDefinition()).toBe(before);
    const w = warnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("[@mnemora/postgres]");
    expect(w[0]).toContain(unknown);
    expect(w[0]).toContain("古い");
  });
});
