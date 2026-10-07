import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

/** 警告の spy は最初の `runMigrations` より前に置く。台帳が空の最初の適用で「番号の最大」が定まらないまま警告を出す実装は、あとから spy を置く形では見えない。 */

const SCHEMA = "mnemora_ledger_drift_warning_edges";
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

describe("runMigrations: 台帳のずれの警告の境目と文面", () => {
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
    warnSpy.mockClear();
  }

  it("台帳が空の最初の適用では警告が出ない", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);

    const first = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });

    expect(first.applied).toEqual(ALL_FILES);
    expect(warnings()).toEqual([]);
  });

  it("台帳の最大と同じ番号の未適用ファイルは、小さい番号ではないので警告せず、いつもどおり当てる", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const dir = mkdtempSync(join(tmpdir(), "mnemora-ledger-same-number-"));
    writeFileSync(join(dir, "0001_first.sql"), "SELECT 1;");
    await runMigrations(pool, dir, { schema: SCHEMA });
    writeFileSync(join(dir, "0001_second.sql"), "SELECT 1;");

    const result = await runMigrations(pool, dir, { schema: SCHEMA });

    expect(result.applied).toEqual(["0001_second.sql"]);
    expect(warnings()).toEqual([]);
  });

  it("手元に無い名前が複数あるとき、警告はその全部を名指しし、手元の版が古い可能性を言う", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await freshSchemaFullyMigrated();
    const unknown = ["9998_from_a_newer_version.sql", "9999_from_a_newer_version.sql"];
    for (const name of unknown) {
      await pool.query(`INSERT INTO "${SCHEMA}"._mnemora_migrations (name) VALUES ($1)`, [name]);
    }

    const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });

    expect(result.applied).toEqual([]);
    const w = warnings();
    expect(w).toHaveLength(1);
    for (const name of unknown) {
      expect(w[0]).toContain(name);
    }
    expect(w[0]).toContain("より古い可能性");
  });

  it("番号で始まらない名前が台帳に在っても、(a) の警告が名指しする基準は番号つきの最大のまま", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await freshSchemaFullyMigrated();
    const unnumbered = "readme_99999.sql";
    await pool.query(`DELETE FROM "${SCHEMA}"._mnemora_migrations WHERE name = $1`, [FILE_0011]);
    await pool.query(`INSERT INTO "${SCHEMA}"._mnemora_migrations (name) VALUES ($1)`, [
      unnumbered,
    ]);

    const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });

    expect(result.applied).toEqual([FILE_0011]);
    const behind = warnings().filter((m) => m.includes("巻き戻"));
    expect(behind).toHaveLength(1);
    expect(behind[0]).toContain(FILE_0011);
    expect(behind[0]).toContain(LAST_FILE);
    expect(behind[0]).not.toContain(unnumbered);
  });

  it("(a) と (b) が同時に起きると、警告は別々の2回に分かれ、(b) の文に (a) のファイルは混ざらない", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await freshSchemaFullyMigrated();
    const unknown = "9999_from_a_newer_version.sql";
    await pool.query(`DELETE FROM "${SCHEMA}"._mnemora_migrations WHERE name = $1`, [FILE_0011]);
    await pool.query(`INSERT INTO "${SCHEMA}"._mnemora_migrations (name) VALUES ($1)`, [unknown]);

    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });

    const w = warnings();
    expect(w).toHaveLength(2);
    const behind = w.filter((m) => m.includes("巻き戻"));
    const newer = w.filter((m) => m.includes("より古い可能性"));
    expect(behind).toHaveLength(1);
    expect(newer).toHaveLength(1);
    expect(behind[0]).toContain(FILE_0011);
    expect(newer[0]).toContain(unknown);
    expect(newer[0]).not.toContain(FILE_0011);
  });
});
