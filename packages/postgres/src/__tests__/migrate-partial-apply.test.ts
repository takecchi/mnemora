import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

describe("runMigrations の複数ファイル境界での部分適用（Issue #756）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("同一呼び出しでNがCOMMIT後にN+1が失敗しても、Nは台帳に残りN+1の途中の効果は残らない。直して再実行するとN+1からだけ再開する", async () => {
    const { pool } = await getTestClient();
    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-boundary-"));

    // N, N+1 相当の2本を先に成功させ、N+2 相当をわざと失敗させる
    // （N+2 は「marker table を作る」→「存在しないテーブルへ INSERT」の2文構成にし、
    // ファイル内の途中まで実行された効果もロールバックされるかを併せて測る）。
    writeFileSync(join(dir, "8001_boundary_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "8002_boundary_b.sql"), "SELECT 1;");
    writeFileSync(
      join(dir, "8003_boundary_broken.sql"),
      "CREATE TABLE mnemora_boundary_marker (id int);\n" +
        "INSERT INTO this_table_does_not_exist_boundary VALUES (1);\n",
    );

    await expect(runMigrations(pool, dir)).rejects.toThrow(/8003_boundary_broken\.sql/);

    const ledgerAfterFailure = await pool.query<{ name: string }>(
      "SELECT name FROM _mnemora_migrations WHERE name LIKE '8%' ORDER BY name",
    );
    expect(ledgerAfterFailure.rows.map((r) => r.name)).toEqual([
      "8001_boundary_a.sql",
      "8002_boundary_b.sql",
    ]);

    const markerExists = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('mnemora_boundary_marker') IS NOT NULL AS exists",
    );
    expect(markerExists.rows[0]?.exists).toBe(false);

    writeFileSync(join(dir, "8003_boundary_broken.sql"), "SELECT 1;");
    const second = await runMigrations(pool, dir);
    expect(second.applied).toEqual(["8003_boundary_broken.sql"]);

    const ledgerAfterRecovery = await pool.query<{ name: string }>(
      "SELECT name FROM _mnemora_migrations WHERE name LIKE '8%' ORDER BY name",
    );
    expect(ledgerAfterRecovery.rows.map((r) => r.name)).toEqual([
      "8001_boundary_a.sql",
      "8002_boundary_b.sql",
      "8003_boundary_broken.sql",
    ]);

    // 後始末: 他テストの「全て適用済み」判定を汚さないよう、このテスト専用の記録を消す。
    await pool.query("DELETE FROM _mnemora_migrations WHERE name LIKE '8%'");
  });

  /**
   * (d) 2プロセス相当が同時に、同じファイル境界（成功→失敗）に当たったときの見え方。advisory lock は `runMigrations()` の入り口全体を排他するので、先着が全体をやり切ってロックを手放してから後着が始まり、
   * 後着は既に成功分が台帳に載っているのを見て飛ばし、失敗するファイルに対して同じ失敗を再現するだけになる。
   * まっさらな専用データベースを使う（advisory lock はデータベースクラスタ全体で共有される名前空間を持つので、他のテストファイルの残骸から独立させる）。
   */
  const DB_BOUNDARY_RACE = "mnemora_756_boundary_race";
  const createdDatabases: string[] = [];
  const openedPools: Pool[] = [];
  let adminPool: Pool | undefined;

  function admin(): Pool {
    adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
    return adminPool;
  }

  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("2プロセス相当が同時に、成功2本+失敗1本のファイル境界に当たっても、直列化されちょうど1回ずつ同じ失敗になる", async () => {
    await dropTempDatabase(admin(), DB_BOUNDARY_RACE);
    await admin().query(`CREATE DATABASE ${DB_BOUNDARY_RACE}`);
    createdDatabases.push(DB_BOUNDARY_RACE);
    const url = new URL(requireDatabaseUrl());
    url.pathname = `/${DB_BOUNDARY_RACE}`;

    const poolA = new Pool({ connectionString: url.toString(), max: 5 });
    const poolB = new Pool({ connectionString: url.toString(), max: 5 });
    openedPools.push(poolA, poolB);

    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-boundary-race-"));
    writeFileSync(join(dir, "0001_ok_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0002_ok_b.sql"), "SELECT 1;");
    writeFileSync(
      join(dir, "0003_broken.sql"),
      "INSERT INTO this_table_does_not_exist_race VALUES (1);",
    );

    const results = await Promise.allSettled([
      runMigrations(poolA, dir, { lockTimeoutMs: 10_000 }),
      runMigrations(poolB, dir, { lockTimeoutMs: 10_000 }),
    ]);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect((r.reason as Error).message).toMatch(/0003_broken\.sql/);
      }
    }

    const ledger = await poolA.query<{ name: string }>(
      "SELECT name FROM _mnemora_migrations ORDER BY name",
    );
    expect(ledger.rows.map((r) => r.name)).toEqual(["0001_ok_a.sql", "0002_ok_b.sql"]);
  }, 20_000);
});
