import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

/** このファイル専用のスキーマ名で走らせ、`public` の台帳には触れない。 */
const SCHEMA_MISSING = "mnemora_dir_unreadable_a";
const SCHEMA_EMPTY = "mnemora_dir_empty_b";

let pool: Pool;
let warnSpy: ReturnType<typeof vi.spyOn>;

function warnings(): string[] {
  return warnSpy.mock.calls
    .map((args: unknown[]) => args[0])
    .filter((m: unknown): m is string => typeof m === "string");
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("rejected されるはずだった");
}

async function schemaExists(name: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [name]);
  return rows.length > 0;
}

describe("runMigrations: migrationsDir が読めない・空（ADR 0448）", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireDatabaseUrl() });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_MISSING}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_EMPTY}" CASCADE`);
    await pool.end();
  });

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it("存在しない migrationsDir は、DB に触れる前に、どの引数が読めなかったかを言って落ちる（CREATE SCHEMA も台帳も作らない）", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_MISSING}" CASCADE`);
    const missing = join(tmpdir(), "mnemora-no-such-dir-adr0448");

    const err = await rejectionOf(runMigrations(pool, missing, { schema: SCHEMA_MISSING }));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("migrationsDir を読めない");
    expect(err.message).toContain(missing);
    expect(err.code).toBe("ENOENT");
    expect((err.cause as { code?: string }).code).toBe("ENOENT");
    expect(await schemaExists(SCHEMA_MISSING)).toBe(false);
  });

  it("ディレクトリでないパスも同じ形で落ちる（code は元のまま）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemora-dir-is-file-"));
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const err = await rejectionOf(runMigrations(pool, file, { schema: SCHEMA_MISSING }));
    expect(err.message).toContain("migrationsDir を読めない");
    expect(err.code).toBe("ENOTDIR");
    expect(await schemaExists(SCHEMA_MISSING)).toBe(false);
  });

  it(".sql が1本も無い migrationsDir は、いままでどおり成功し（applied: []）、警告で名乗る", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_EMPTY}" CASCADE`);
    const dir = mkdtempSync(join(tmpdir(), "mnemora-empty-dir-"));
    writeFileSync(join(dir, "README.md"), "not a migration");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runMigrations(pool, dir, { schema: SCHEMA_EMPTY });

    expect(result.applied).toEqual([]);
    const w = warnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("[@mnemora/postgres]");
    expect(w[0]).toContain(".sql が1本も無い");
  });

  it(".sql が1本も無くても、専用スキーマと台帳は作られて残る（ADR 0552 が書いた副作用。ADR 0589 の P8）", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_EMPTY}" CASCADE`);
    const dir = mkdtempSync(join(tmpdir(), "mnemora-empty-dir-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runMigrations(pool, dir, { schema: SCHEMA_EMPTY });

    expect(result.applied).toEqual([]);
    expect(await schemaExists(SCHEMA_EMPTY)).toBe(true);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA_EMPTY}"._mnemora_migrations`,
    );
    expect(rows[0].n).toBe(0);
  });
});
