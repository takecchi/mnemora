import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * `runMigrations` が、台帳（`_mnemora_migrations`）と手元の `migrations/*.sql` のずれを
 * 見つけたら**警告を出して続行する**ことの歯（穴探し6巡目 S-1・S-3、ADR 0425）。
 *
 * - (a) 未適用のファイルのうち、台帳の最大の番号より小さいものが在る（S-1）:
 *   台帳から 0011 の行だけが欠けた DB で流すと、0011 が単独で当たり直り、0018 が足した
 *   `'unsuperseded'` が `memory_events_kind_check` から黙って消える。
 * - (b) 台帳にある名前が、手元のファイルに無い（S-3）: 新しい版で上げた DB に古い版から
 *   流すと、何も言わずに「すべて適用済み」になる。
 *
 * どちらも**止めない**（throw しない・適用の順序と中身は変えない）。
 *
 * 専用スキーマ（このファイル専用の名前）の中で走らせ、`public` の台帳（他のテストが
 * 共有する）には触れない。`analyze-memories.postgres.test.ts` と同じ作法。
 */

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

    // 止めない・いまどおり当てる。
    expect(result.applied).toEqual([FILE_0011]);
    // S-1 の実害: 0018 が足した値が黙って消える。
    expect(await kindCheckDefinition()).not.toContain("unsuperseded");
    // 警告は、当たり直されるファイルと、台帳の最大の番号（基準）を名指しする。
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
