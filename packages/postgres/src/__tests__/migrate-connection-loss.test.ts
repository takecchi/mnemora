import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrationLockKeyFor, runMigrations } from "../migrate.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * `runMigrations` が使う2種類のコネクション（`advisory-lock.ts` の `acquireAdvisoryLock`
 * が `pool.connect()` で借り切るロック保持用クライアントと、`migrate.ts` 本体が
 * ファイルごとのトランザクションのために `pool.connect()` で借りるクライアント）は、
 * どちらも `pg` の「checked-out client には呼び出し側が自分で `error` リスナーを
 * 付けること」という要求（`pg` 自身のドキュメント）を満たしていない。
 * （2026-09-27 追記、Issue #1212: いまは本体もロック保持用クライアントで流すので、
 * コネクションは1本である。以下は、この歯を書いた時点の記録として残す。）
 *
 * **観測した壊れ方**: DB 側が接続を切る（`pg_terminate_backend`——実運用では DB の
 * 再起動・フェイルオーバー・運用者の手動切断・OOM kill 等がこれと同じ形で起こりうる）と、
 * `runMigrations` が返す Promise は resolve も reject もせず、代わりに Node の
 * `EventEmitter` が `error` イベントをそのまま投げて**プロセス全体が uncaught exception
 * で落ちる**。呼び出し側の `try { await runMigrations(...) } catch { ... }` は一切
 * 実行されない——`migrate.ts` 自身が約束している「失敗したら
 * `Error('migration <file> failed: ...')` を throw する」という契約
 * （`migrate.test.ts` の「失敗したマイグレーションはロールバックされ、適用済みとして
 * 記録されない」歯が検査している契約そのもの）が、この壊れ方のクラスに対してだけ
 * 素通りしている。
 *
 * ⚠ **[ADR 0020](../../../../docs/decisions/0020-temp-database-drain-before-drop.md)
 * が却下した `pool.on('error', () => {})` とは別の話である。** ADR 0020 が却下したのは、
 * *自分自身の* `pool.end()` が実はソケットを閉じ切っていなかった（閉じ切ったと誤認して
 * `DROP DATABASE ... WITH (FORCE)` を撃ち、その FORCE が自分の生きた接続を殺す）という
 * **自傷**を、`pool.on('error')` で症状だけ黙らせる案——「閉じ切れていない接続がある」
 * という本当の不具合を検出できなくする、というのが却下理由だった。
 * ここでの壊れ方は自傷ではない——**外部要因（運用者・DB 側・ネットワーク）による、
 * 構造的に避けられない接続断**であり、`client` は最後まで正しく `release()` されている
 * （リークは無い）。`pg` 自身が「checked-out client の接続断は、呼び出し側が
 * `client.on('error', ...)` を付けて自分で拾うこと」と明記しているのはこのクラスの
 * ためであり、ADR 0020 が塞いだ「本当は生きている接続を死んだと誤認する」問題とは
 * 直交する。
 */
describe("runMigrations: 接続が外部要因で失われたとき", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  // `_mnemora_migrations` はドメインテーブルではないため `resetTestDatabase()` の
  // TRUNCATE 対象に含まれない（意図的——通常のテストはマイグレーション済みの状態を
  // 前提にする）。この歯は成功時に台帳へ行を残す（9402/9403）ため、手元で同じ
  // データベースに対して複数回再実行すると「既に適用済みなので今回は何もしない」に
  // なり、2回目以降が偽陰性で緑になる（≠ 直っていないのに緑）。CI は毎回まっさらな
  // データベースなので実害は無いが、手元の再実行に対して独立にしておく。
  beforeEach(async () => {
    const { pool } = await getTestClient();
    await pool.query("DELETE FROM _mnemora_migrations WHERE name IN ($1, $2, $3, $4)", [
      "9401_connloss_file.sql",
      "9402_connloss_lock.sql",
      "9403_connloss_followup.sql",
      "9404_connloss_overlap.sql",
    ]);
  });

  /**
   * `pid` が見つかるまで `pg_stat_activity` をポーリングする。`SELECT pg_sleep(...)` を
   * 含むマイグレーション本体、または `pg_advisory_lock` を含むクエリのどちらかを
   * 目印にする——どちらも、この歯以外の場所で偶然同じ文字列を検索対象の DB に対して
   * 実行することは無い（`getTestClient()` が使う共有 DB に対して、この歯の実行中は
   * 他にこの文字列を含むクエリは走らない）。
   */
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
   * `lockKey` の advisory lock を持っているバックエンドの `pid` を `pg_locks` から探す。
   * bigint のキーは `classid`（上位32bit）と `objid`（下位32bit）に分かれて載る（`objsubid = 1`）。
   * ロックを持つ接続が最後に流したクエリは本体のことがあるので、`pg_stat_activity` の
   * 文字列では見分けない。
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

    // ロックを持つ接続は、本体（`pg_sleep(5)`）も流している接続である（Issue #1212）。
    // 本体が流れ始めてから、既定のキー（接続の `current_schema()` から導く）のロックを持つ
    // バックエンドを `pg_locks` で探して切る。
    await waitForBackendRunning(pool, "%pg_sleep(5)%");
    const { rows: schemaRows } = await pool.query<{ s: string }>("SELECT current_schema() AS s");
    const pid = await waitForAdvisoryLockHolder(pool, migrationLockKeyFor(schemaRows[0]!.s));
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);

    // 本体はロックを持つ接続で流れているので、一緒に終わってコミットされない。失敗は、
    // 最後の `releaseMigrationLock`（`pg_advisory_unlock`）の失敗ではなく、適用していた
    // ファイルの失敗として報告される。
    // （#1216 までは本体が別の接続で流れていたため、本体はコミットされ、呼び出し全体は
    // ロックの返却の失敗で reject していた——その非対称を、ここで観測として縛っていた。）
    await expect(migrating).rejects.toThrow(/^migration 9402_connloss_lock\.sql failed: /);

    const recorded = await pool.query("SELECT name FROM _mnemora_migrations WHERE name = $1", [
      "9402_connloss_lock.sql",
    ]);
    expect(recorded.rows).toEqual([]);

    // advisory lock は PostgreSQL 側でセッション（コネクション）に紐づく——
    // `pg_terminate_backend` でセッションごと終わらせれば、明示的な
    // `pg_advisory_unlock` が失敗していても、サーバー側は自動的にロックを手放す。
    // ⟹ 次の `runMigrations` 呼び出しが、解放されないロックを待ち続けて
    // ハングしないことまで確かめる（`lockTimeoutMs` を短くし、待たされる場合は
    // `MigrationLockTimeoutError` で早く赤くなるようにしておく——ハングを
    // タイムアウト無しで待つ歯にしない）。
    const dir2 = mkdtempSync(join(tmpdir(), "mnemora-migrate-connloss-followup-"));
    writeFileSync(join(dir2, "9403_connloss_followup.sql"), "SELECT 1;");
    const followUp = await runMigrations(pool, dir2, { lockTimeoutMs: 5_000 });
    expect(followUp.applied).toEqual(["9403_connloss_followup.sql"]);
  }, 20_000);

  it("advisory lock を保持している接続が失われると、適用もそこで止まり、ロックの外で本体が流れ続けない（Issue #1212）", async () => {
    // ADR 0017 の約束（ロックを持つ間だけ適用し、適用は直列になる）を縛る。#1216 では
    // 「ロックを失っても本体が別の接続で流れ続け、その間に別のセッションが同じロックを取れる」を
    // 今の振る舞いとして縛っていた——それを反転させたもの。
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

    // ロックを失った後、本体（pg_sleep(3)）はすぐに止まる——ロックの外で流れ続けない。
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

    // 失敗は、最後のロックの返却の失敗ではなく、適用していたファイルの失敗として報告され、
    // そのファイルは適用済みとして記録されない。
    expect((await migrating).message).toMatch(/^migration 9404_connloss_overlap\.sql failed: /);
    const recorded = await pool.query("SELECT name FROM _mnemora_migrations WHERE name = $1", [
      "9404_connloss_overlap.sql",
    ]);
    expect(recorded.rows).toEqual([]);
  }, 20_000);
});
