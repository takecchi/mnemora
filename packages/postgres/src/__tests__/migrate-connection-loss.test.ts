import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrationLockKeyFor, runMigrations } from "../migrate.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * `runMigrations` が使う接続は、`pg` が要求する「checked-out client には呼び出し側が自分で `error` リスナーを付けること」を満たさないと、DB 側が接続を切った（`pg_terminate_backend`。DB の再起動・フェイルオーバー・OOM kill 等と同じ形）とき、
 * Promise が resolve も reject もせず `error` イベントでプロセス全体が uncaught exception で落ちる。
 * `pool.on('error', () => {})` で症状だけ黙らせる案とは別の話で、ここでの接続断は外部要因で構造的に避けられず、`client` は最後まで正しく `release()` されている（リークは無い）。
 */
describe("runMigrations: 接続が外部要因で失われたとき", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  // `_mnemora_migrations` は `resetTestDatabase()` の TRUNCATE 対象に含まれないので、この歯は成功時に台帳へ行を残し、同じ DB に対して再実行すると「既に適用済み」になって偽陰性で緑になる。再実行に対して独立にしておく。
  beforeEach(async () => {
    const { pool } = await getTestClient();
    await pool.query("DELETE FROM _mnemora_migrations WHERE name IN ($1, $2, $3, $4)", [
      "9401_connloss_file.sql",
      "9402_connloss_lock.sql",
      "9403_connloss_followup.sql",
      "9404_connloss_overlap.sql",
    ]);
  });

  /** `pid` が見つかるまで `pg_stat_activity` をポーリングする。`SELECT pg_sleep(...)` を含むマイグレーション本体、または `pg_advisory_lock` を含むクエリのどちらかを目印にする。 */
  async function waitForBackendRunning(
    pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: { pid: number }[] }> },
    likePattern: string,
  ): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE query ILIKE $1 AND pid <> pg_backend_pid()",
        [likePattern],
      );
      if (rows.length > 0) {
        return rows[0]!.pid;
      }
      await sleep(50);
    }
    throw new Error(`waitForBackendRunning: ${likePattern} に一致するバックエンドが現れなかった`);
  }

  /**
   * `lockKey` の advisory lock を持っているバックエンドの `pid` を `pg_locks` から探す。bigint のキーは `classid`（上位32bit）と `objid`（下位32bit）に分かれて載る（`objsubid = 1`）。
   * ロックを持つ接続が最後に流したクエリは本体のことがあるので、`pg_stat_activity` の文字列では見分けない。
   */
  async function waitForAdvisoryLockHolder(
    pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: { pid: number }[] }> },
    lockKey: bigint,
  ): Promise<number> {
    const unsigned = BigInt.asUintN(64, lockKey);
    const classid = String(unsigned >> 32n);
    const objid = String(unsigned & 0xffff_ffffn);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await pool.query(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1 AND classid::text = $1 AND objid::text = $2",
        [classid, objid],
      );
      if (rows.length > 0) {
        return rows[0]!.pid;
      }
      await sleep(50);
    }
    throw new Error(`waitForAdvisoryLockHolder: ${lockKey} を持つバックエンドが現れなかった`);
  }

  it("マイグレーション本体を実行中の接続が失われても、runMigrations は例外で reject する（プロセスを落とさない）", async () => {
    const { pool } = await getTestClient();
    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-connloss-file-"));
    writeFileSync(join(dir, "9401_connloss_file.sql"), "SELECT pg_sleep(5);");

    const migrating = runMigrations(pool, dir);

    const pid = await waitForBackendRunning(pool, "%pg_sleep(5)%");
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);

    await expect(migrating).rejects.toThrow(/9401_connloss_file\.sql/);

    const recorded = await pool.query("SELECT name FROM _mnemora_migrations WHERE name = $1", [
      "9401_connloss_file.sql",
    ]);
    expect(recorded.rows).toEqual([]);
  }, 20_000);

  it("advisory lock を保持しているクライアントの接続が失われても、runMigrations は例外で reject する（プロセスを落とさない）", async () => {
    const { pool } = await getTestClient();
    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-connloss-lock-"));
    writeFileSync(join(dir, "9402_connloss_lock.sql"), "SELECT pg_sleep(5);");

    const migrating = runMigrations(pool, dir);

    await waitForBackendRunning(pool, "%pg_sleep(5)%");
    const { rows: schemaRows } = await pool.query<{ s: string }>("SELECT current_schema() AS s");
    const pid = await waitForAdvisoryLockHolder(pool, migrationLockKeyFor(schemaRows[0]!.s));
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);

    // 本体はロックを持つ接続で流れているので、一緒に終わってコミットされない。失敗は、最後のロックの返却の失敗ではなく、適用していたファイルの失敗として報告される。
    await expect(migrating).rejects.toThrow(/^migration 9402_connloss_lock\.sql failed: /);

    const recorded = await pool.query("SELECT name FROM _mnemora_migrations WHERE name = $1", [
      "9402_connloss_lock.sql",
    ]);
    expect(recorded.rows).toEqual([]);

    // advisory lock は PostgreSQL 側でセッションに紐づくので、`pg_terminate_backend` でセッションごと終わらせれば、`pg_advisory_unlock` が失敗していても、サーバー側は自動的にロックを手放す。
    // 次の `runMigrations` が解放されないロックを待ち続けてハングしないことまで確かめる（`lockTimeoutMs` を短くし、ハングをタイムアウト無しで待つ歯にしない）。
    const dir2 = mkdtempSync(join(tmpdir(), "mnemora-migrate-connloss-followup-"));
    writeFileSync(join(dir2, "9403_connloss_followup.sql"), "SELECT 1;");
    const followUp = await runMigrations(pool, dir2, { lockTimeoutMs: 5_000 });
    expect(followUp.applied).toEqual(["9403_connloss_followup.sql"]);
  }, 20_000);

  it("advisory lock を保持している接続が失われると、適用もそこで止まり、ロックの外で本体が流れ続けない（Issue #1212）", async () => {
    const { pool } = await getTestClient();
    const lockKey = 7_190_158_676_462_701_404n;
    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-connloss-overlap-"));
    writeFileSync(join(dir, "9404_connloss_overlap.sql"), "SELECT pg_sleep(3);");

    const migrating = runMigrations(pool, dir, { lockKey }).then(
      () => new Error("resolved"),
      (error: unknown) => error as Error,
    );
    await waitForBackendRunning(pool, "%pg_sleep(3)%");
    const lockHolder = await waitForAdvisoryLockHolder(pool, lockKey);
    await pool.query("SELECT pg_terminate_backend($1)", [lockHolder]);

    let stillRunning = -1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query ILIKE '%pg_sleep(3)%' AND state = 'active' AND pid <> pg_backend_pid()",
      );
      stillRunning = rows[0]!.n;
      if (stillRunning === 0) break;
      await sleep(50);
    }
    expect(stillRunning).toBe(0);

    expect((await migrating).message).toMatch(/^migration 9404_connloss_overlap\.sql failed: /);
    const recorded = await pool.query("SELECT name FROM _mnemora_migrations WHERE name = $1", [
      "9404_connloss_overlap.sql",
    ]);
    expect(recorded.rows).toEqual([]);
  }, 20_000);
});
