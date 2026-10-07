import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { closeTestClient, getTestClient } from "./test-db.js";

describe("runMigrations", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("既に全て適用済みの場合、二度目の呼び出しは何も適用しない（冪等）", async () => {
    const { pool } = await getTestClient(); // ここで 0001_init.sql は既に適用済み
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([]);
  });

  it("失敗したマイグレーションはロールバックされ、適用済みとして記録されない", async () => {
    const { pool } = await getTestClient();
    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-test-"));
    writeFileSync(
      join(dir, "9001_broken.sql"),
      "CREATE TABLE mnemora_migrate_test_broken (id int); INSERT INTO this_table_does_not_exist VALUES (1);",
    );

    await expect(runMigrations(pool, dir)).rejects.toThrow(/9001_broken\.sql/);

    const recorded = await pool.query("SELECT name FROM _mnemora_migrations WHERE name = $1", [
      "9001_broken.sql",
    ]);
    expect(recorded.rows).toEqual([]);

    const tableExists = await pool.query(
      "SELECT to_regclass('mnemora_migrate_test_broken') IS NOT NULL AS exists",
    );
    expect(tableExists.rows[0]?.exists).toBe(false);
  });

  it("一部だけ未適用の場合、未適用のものだけを名前の昇順で適用する", async () => {
    const { pool } = await getTestClient();
    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-test-"));
    writeFileSync(join(dir, "0001_noop_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0002_noop_b.sql"), "SELECT 1;");

    const first = await runMigrations(pool, dir);
    expect(first.applied).toEqual(["0001_noop_a.sql", "0002_noop_b.sql"]);

    const second = await runMigrations(pool, dir);
    expect(second.applied).toEqual([]);

    // 後始末: このテスト専用の記録を消す（他テストの「全て適用済み」判定を汚さないため）。
    await pool.query("DELETE FROM _mnemora_migrations WHERE name IN ($1, $2)", [
      "0001_noop_a.sql",
      "0002_noop_b.sql",
    ]);
  });
});
