import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/** `SET LOCAL search_path TO ...` は `schema` だけでなく `extensionSchema` も二重引用符で囲み、`schema[,extensionSchema]` のほかは何も足さない。拡張を置くスキーマが予約語の場合も、並びに余分な要素が混ざらないことを見る。 */

const DATABASE = "mnemora_reserved_ext_schema";

let adminPool: Pool | undefined;
let pool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

describe("runMigrations: search_path の引用符は schema と extensionSchema の両方に付き、並びは増えない", () => {
  afterAll(async () => {
    await pool?.end();
    await dropTempDatabase(admin(), DATABASE);
    await adminPool?.end();
  });

  it("extensionSchema: 'user'（予約語）で適用でき、マイグレーション中の search_path は schema と extensionSchema の2つだけ", async () => {
    await dropTempDatabase(admin(), DATABASE);
    await admin().query(`CREATE DATABASE ${DATABASE}`);
    // 最後の pgvector の能力検査は `SET LOCAL` の外で流れるので、接続自身の既定の search_path が拡張のスキーマに届いている必要がある。
    pool = new Pool({
      connectionString: connectionStringFor(DATABASE),
      max: 3,
      options: "-c search_path=public,user",
    });
    await pool.query('CREATE SCHEMA "user"');

    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-reserved-ext-"));
    writeFileSync(
      join(dir, "9001_probe.sql"),
      "CREATE TABLE sp_probe AS SELECT current_setting('search_path') AS path;",
    );

    const result = await runMigrations(pool, dir, {
      schema: "mnemora_reserved_ext",
      extensionSchema: "user",
    });
    expect(result.applied).toEqual(["9001_probe.sql"]);

    const { rows } = await pool.query<{ path: string }>(
      'SELECT path FROM "mnemora_reserved_ext".sp_probe',
    );
    // PostgreSQL は、引用符が要る名前（`user`）にだけ引用符を付けて、`, ` 区切りで返す。
    expect(rows.map((row) => row.path)).toEqual(['mnemora_reserved_ext, "user"']);
  }, 60_000);
});
