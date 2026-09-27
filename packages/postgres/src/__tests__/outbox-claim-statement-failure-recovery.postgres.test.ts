import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `claimBatch` の文が途中で失敗しても（`lock_timeout`・接続断）、**ジョブを取りこぼさない**こと。
 *
 * ## 約束が書かれている場所
 * - `OutboxStore` の冒頭の契約（`packages/core/src/interfaces/outbox-store.ts`）:
 *   `claimBatch` は `completed_at IS NULL AND failed_at IS NULL` かつ `available_at <= now` の
 *   ジョブを返す。リース（ADR 0032）は、終端に達しないジョブが「二度と claim されず、どこからも
 *   見えなくなる」ことを避けるためにある。
 * - [ADR 0206](../../../../docs/decisions/0206-outbox-concurrent-claim-conformance.md)
 *   「その後（2026-09-17）」: 誰にも拾われない行が生じるには「ロックを持つが claim しない者」が
 *   要る。文がエラー・`lock_timeout`・接続断でロールバックする経路は「確かめていないこと」に
 *   残っていた——この歯がそこを測る。
 *
 * ## この歯が縛ること
 * 失敗した `claimBatch` の後、ジョブは **claim されていないまま**（`claimed_at` が無く、`attempts` も
 * 進んでいない）であり、**同じ `now` での次の `claimBatch` が、リースの切れを待たずに拾う**。
 * ⚠ 「リースを待たずに」は、上の文書が約束として書いている範囲より一段強い。今の実装が
 * `claimBatch` を1つの SQL 文（`SELECT … FOR UPDATE SKIP LOCKED` の CTE と同じ文の `UPDATE`）で
 * 書いており、Postgres が1文を丸ごとロールバックすることに拠っている。
 *
 * ⚠ **測っていないこと**: この歯が起こす失敗は、文がテーブルのロックを待つ段（claim を書く前）で
 * 起きる。claim を書いた**後**の失敗（たとえば `claimBatch` をトランザクションの無い複数の文に
 * 分け、後の文が落ちる形）は、この起こし方では作れない。そうした回帰は、この歯では捕まらない。
 *
 * ## 失敗の起こし方
 * 別の接続で `outbox` にテーブルの `ACCESS EXCLUSIVE` ロックを持つ。`claimBatch` は行に届く前、
 * テーブルのロックを取る段で待たされる（`SKIP LOCKED` は行のロックにしか効かないので、迂回できない）。
 * その待ちを `lock_timeout` で打ち切るか、backend を `pg_terminate_backend` で切る。
 *
 * ⚠ ロックを持つ接続（`holder`）を放す前に、共有のプールで `outbox` を読むと、その読みもロック待ちで
 * 止まる。各 `it` で「ロックを放す → 共有のプールで確かめる」の順を守ること。
 */
describe("PostgresOutboxStore.claimBatch — 文が途中で失敗しても、ジョブを取りこぼさない（ADR 0206）", () => {
  const TENANT = `outbox-claim-rollback-${randomUUID()}`;

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /**
   * `available_at` は、歯が `claimBatch` に渡す `now` と同じ値で書く。
   * ⚠ DB の `now()` で書かないこと。`now()` はマイクロ秒まで持ち、JS の `Date` はミリ秒で切れる。同じ
   * ミリ秒の内だと `available_at > now` になり、`claimBatch` が拾わない（【実測】CI で両脚とも1本ずつ赤になった）。
   */
  async function seedClaimableJob(ctx: Ctx, availableAt: Date): Promise<string> {
    const { pool } = await getTestClient();
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, $2, 0, $2)
       RETURNING id`,
      [ctx.tenantId, availableAt],
    );
    const jobId = seeded.rows[0]?.id;
    if (jobId === undefined) throw new Error("seed に失敗した");
    return jobId;
  }

  async function readClaimState(jobId: string) {
    const { pool } = await getTestClient();
    const result = await pool.query<{ claimed_at: Date | null; attempts: number }>(
      `SELECT claimed_at, attempts FROM outbox WHERE id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("行が消えている");
    return row;
  }

  /** 失敗の後の約束: claim されておらず、同じ `now` での次の `claimBatch` が拾う。 */
  async function expectNotClaimedAndReclaimable(ctx: Ctx, jobId: string, now: Date) {
    const before = await readClaimState(jobId);
    expect(before.claimed_at).toBeNull();
    expect(before.attempts).toBe(0);

    const store = new PostgresOutboxStore((await getTestClient()).db);
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now,
      claimedBy: "recovery-claimer",
      leaseMs: 60_000,
    });
    expect(claimed.map((j) => j.id)).toContain(jobId);
    const after = await readClaimState(jobId);
    expect(after.claimed_at).not.toBeNull();
    expect(after.attempts).toBe(1);
  }

  it("lock_timeout で文が打ち切られた後も、ジョブは claim されておらず、次の claimBatch が拾う", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const now = new Date();
    const jobId = await seedClaimableJob(ctx, now);
    const { pool } = await getTestClient();

    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE");

    const claimerClient = createPostgresClient(requireDatabaseUrl(), {
      options: "-c lock_timeout=200ms",
      max: 1,
    });
    const claimerStore = new PostgresOutboxStore(claimerClient.db);

    let caughtError: unknown;
    try {
      await claimerStore.claimBatch(ctx, {
        limit: 10,
        now,
        claimedBy: "failing-claimer",
        leaseMs: 60_000,
      });
    } catch (err) {
      caughtError = err;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await closePostgresClient(claimerClient).catch(() => {});
    }

    // 検算: 起こした失敗が実際に起きた（claimBatch が投げた）。
    expect(caughtError).toBeDefined();
    await expectNotClaimedAndReclaimable(ctx, jobId, now);
  });

  it("文の実行中に backend が切られた後も、ジョブは claim されておらず、次の claimBatch が拾う", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const now = new Date();
    const jobId = await seedClaimableJob(ctx, now);
    const { pool } = await getTestClient();

    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE");

    // max: 1 の専用のプール。backend を切られたときの 'error' を拾わないと、プロセスが落ちる。
    const claimerClient = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    claimerClient.pool.on("error", () => {
      // 意図して無視する。結果は claimBatch の reject で見る。
    });
    const claimerStore = new PostgresOutboxStore(claimerClient.db);

    let caughtError: unknown;
    try {
      // max: 1 なので、この接続が claimBatch でも使われる。
      const pidResult = await claimerClient.pool.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const claimerPid = pidResult.rows[0]?.pid;
      expect(claimerPid).toBeDefined();

      const claimPromise = claimerStore
        .claimBatch(ctx, { limit: 10, now, claimedBy: "terminated-claimer", leaseMs: 60_000 })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      // テーブルのロック待ちに入ってから切る。
      await new Promise((resolve) => setTimeout(resolve, 300));
      await pool.query("SELECT pg_terminate_backend($1)", [claimerPid]);
      caughtError = await claimPromise;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await closePostgresClient(claimerClient).catch(() => {});
    }

    // 検算: 起こした失敗が実際に起きた（claimBatch が投げた）。
    expect(caughtError).toBeDefined();
    await expectNotClaimedAndReclaimable(ctx, jobId, now);
  });
});
