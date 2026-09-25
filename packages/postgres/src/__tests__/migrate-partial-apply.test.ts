import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * Issue #756（#168 項目2-2の当て直し。ADR 0017 の「確かめていないこと」——
 * マイグレーションファイルが複数本に増え、衝突点がファイル内の途中〜ファイル境界へ
 * 移ったときに部分適用が残るかは外挿であり実測していない、という記述——の実測）。
 *
 * `migrate.ts` の `runMigrations` は、1ファイル = 1トランザクション
 * （`BEGIN` → 本文 → `_mnemora_migrations` へ INSERT → `COMMIT`、失敗で `ROLLBACK` して
 * throw）で未適用ファイルを名前順に流す。**同じ呼び出しの中で複数の新規ファイルが
 * 並んでいて、前のファイルが COMMIT された後に次のファイルが失敗したらどうなるか**
 * （ファイル N は台帳に残るか／N+1 内で失敗前に実行された DDL は残らないか／
 * 直してから再実行すると N を二重適用せず N+1 から再開するか）は、
 * `migrate.test.ts` の既存の歯には無い——`migrate.test.ts` の「失敗したマイグレーションは
 * ロールバックされ…」の歯は、共有プール（既に0001〜0021本が適用済み）に対して
 * *この呼び出しで新規に処理するファイルが1本だけ*（`9001_broken.sql`）の状態で
 * 失敗させており、「この呼び出し内で先に1本以上COMMITしてから次が失敗する」形には
 * なっていない。ここではその形を明示的に作る。
 *
 * 本ファイルは `runMigrations` の挙動・既定値・`migrations/*.sql` を一切変えない
 * ——観測するだけの歯を足す。
 */
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

    // (a) 台帳: N・N+1（8001・8002）は残り、N+2（8003）は残っていない。
    const ledgerAfterFailure = await pool.query<{ name: string }>(
      "SELECT name FROM _mnemora_migrations WHERE name LIKE '8%' ORDER BY name",
    );
    expect(ledgerAfterFailure.rows.map((r) => r.name)).toEqual([
      "8001_boundary_a.sql",
      "8002_boundary_b.sql",
    ]);

    // (b) 8003内で失敗前に実行されたDDL（marker table作成）の効果は残っていない
    // （ファイル単位のトランザクションがロールバックしたため）。
    const markerExists = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('mnemora_boundary_marker') IS NOT NULL AS exists",
    );
    expect(markerExists.rows[0]?.exists).toBe(false);

    // (c) 失敗原因を除いて再実行すると、8001・8002を二重適用せず8003からだけ再開する。
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
   * (d) 2プロセス相当が同時に、同じファイル境界（成功→失敗）に当たったときの見え方。
   *
   * ADR 0017 の advisory lock は `runMigrations()` の入り口全体（`handOverLegacyMigrationsTable`
   * の前から最後の COMMIT まで）を排他するため、2プロセスがここで同時に DDL を撃ち合う
   * ことはなく、**先着が全体（成功分＋失敗するファイル）をやり切ってロックを手放してから、
   * 後着が始まる**——後着は既に成功分が台帳に載っているのを見て飛ばし、失敗するファイルに
   * 対して同じ失敗を再現するだけになるはず、という理解を実測する。
   *
   * まっさらな専用データベースを使う（advisory lock はデータベースクラスタ全体で共有される
   * 名前空間を持つため、他のテストファイルの残骸から独立させる必要がある。
   * `migrate-concurrency.test.ts` と同じ理由）。
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

    // 両方とも同じファイルの失敗で落ちる（黙って成功しない。二重適用の痕跡もない）。
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect((r.reason as Error).message).toMatch(/0003_broken\.sql/);
      }
    }

    // 台帳には成功した2本だけが、それぞれちょうど1回だけ載っている
    // （直列化されているので、どちらかが2回実行して重複INSERTで壊れる、ということが無い）。
    const ledger = await poolA.query<{ name: string }>(
      "SELECT name FROM _mnemora_migrations ORDER BY name",
    );
    expect(ledger.rows.map((r) => r.name)).toEqual(["0001_ok_a.sql", "0002_ok_b.sql"]);
  }, 20_000);
});
