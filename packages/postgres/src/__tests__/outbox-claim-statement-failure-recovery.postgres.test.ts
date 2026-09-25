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
 * ADR 0206「確かめていないこと」を埋める歯:
 *
 * > **ロールバック経路（文の失敗・`lock_timeout`・接続断）での取りこぼしは測っていない。**
 * > … 誰にも拾われない行が生じるには、「ロックを持つが claim しない者」が要る。
 *
 * `PostgresOutboxStore.claimBatch` は単一の SQL 文（CTE の `SELECT … FOR UPDATE SKIP
 * LOCKED` を同じ文の `UPDATE` が claim する）であり、**明示的な `BEGIN`/`COMMIT` を
 * アプリケーションコードが書かない**——`db.execute` 1回が暗黙の1文トランザクションである。
 * この歯は、その1文が**最後まで実行されずに異常終了した**とき、Postgres の
 * 「1文は丸ごとコミットされるか丸ごとロールバックされるかのどちらか」という保証が
 * 実際に成り立ち、**ジョブが「ロックされたが claim されなかった」まま取り残されない**
 * ことを、本物の Postgres に対して実測する。
 *
 * ⚠ **`FOR UPDATE SKIP LOCKED` 自体は、行レベルでロック中の行を待たずに飛ばす**ため、
 * 通常の運用では `claimBatch` の文自体が `lock_timeout` に掛かることはまず無い
 * （ADR 0206 の「なぜ自然条件では出ないのか」参照）。**この歯が文を失敗させるために
 * 使う手段は、テーブルレベルの `ACCESS EXCLUSIVE` ロック**——`claimBatch` の `SELECT`
 * が行に辿り着く**前**、テーブルへの `AccessShareLock` を取る段階でブロックさせる。
 * これは `SKIP LOCKED`（行レベル）では迂回できない、意図的に作った失敗経路である。
 *
 * ⚠ **`db.execute` が投げる例外は drizzle-orm の `DrizzleQueryError` でラップされている
 * ——元の `pg` のエラー（`code: '55P03'` 等）は `.cause` に入る**（探索過程で実測）。
 *
 * ⚠ **テーブルロックを握ったままの接続（`holder`）を解放する前に、共有プール
 * （`getTestClient()`）経由で `outbox` を読むと、その読み取り自体がロック待ちで
 * ブロックする**（探索過程で実際に30秒 timeout を踏んだ）。⟹ 各 it 内で
 * 「ロック解放 → 共有プールでの確認」の順序を厳密に守ること。
 */
describe("PostgresOutboxStore.claimBatch — 文が異常終了しても取りこぼさない（ADR 0206 の確かめていないこと）", () => {
  const TENANT = `outbox-claim-rollback-${randomUUID()}`;

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function seedClaimableJob(ctx: Ctx): Promise<string> {
    const { pool } = await getTestClient();
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
       RETURNING id`,
      [ctx.tenantId],
    );
    const jobId = seeded.rows[0]?.id;
    if (jobId === undefined) throw new Error("seed 失敗");
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

  it("文の失敗（lock_timeout でテーブルロック待ちがキャンセルされる）後も、ジョブは再び claim できる", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const jobId = await seedClaimableJob(ctx);
    const { pool } = await getTestClient();

    // 1. 別接続で outbox テーブル全体を ACCESS EXCLUSIVE ロックしたまま保持する（コミットしない）。
    //    claimBatch の SELECT は行に辿り着く前に AccessShareLock の取得でブロックされる
    //    ——SKIP LOCKED は行レベルなので、これは迂回できない。
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE");

    // 2. lock_timeout を短く敷いた専用クライアントで claimBatch を撃つ。
    const claimerClient = createPostgresClient(requireDatabaseUrl(), {
      options: "-c lock_timeout=200ms",
      max: 1,
    });
    const claimerStore = new PostgresOutboxStore(claimerClient.db);

    let caughtError: unknown;
    try {
      await claimerStore.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "rollback-claimer",
        leaseMs: 60_000,
      });
    } catch (err) {
      caughtError = err;
    } finally {
      // 3. 共有プールで outbox を読む前に、必ずロックを手放す（doc コメント参照）。
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await closePostgresClient(claimerClient).catch(() => {});
    }

    expect(caughtError).toBeDefined();
    const pgErrorCode = (caughtError as { cause?: { code?: string } } | undefined)?.cause?.code;
    expect(pgErrorCode).toBe("55P03"); // canceling statement due to lock timeout

    // 4. ロックを手放した後、行がまだ未 claim のままであることを確認する
    //    （失敗した文が部分的な書き込みを残していない）。
    const stateBeforeRecovery = await readClaimState(jobId);
    expect(stateBeforeRecovery.claimed_at).toBeNull();
    expect(stateBeforeRecovery.attempts).toBe(0);

    // 5. 通常の claimBatch で問題なく拾える（取りこぼしていない）。
    const store = new PostgresOutboxStore((await getTestClient()).db);
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "recovery-claimer",
      leaseMs: 60_000,
    });
    expect(claimed.map((j) => j.id)).toContain(jobId);
    const stateAfter = await readClaimState(jobId);
    expect(stateAfter.claimed_at).not.toBeNull();
    expect(stateAfter.attempts).toBe(1);
  });

  it("接続断（実行中の文の裏で backend が pg_terminate_backend で切られる）後も、ジョブは再び claim できる", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const jobId = await seedClaimableJob(ctx);
    const { pool } = await getTestClient();

    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE");

    // claimer 専用の Pool（max: 1）。'error' ハンドラを付けないと、pg_terminate_backend で
    // 切られたときに素の Pool/Client が unhandled 'error' イベントで process を落とす
    // （pg@8.23.0 の既知の挙動——探索過程で実測した）。
    const claimerClient = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    claimerClient.pool.on("error", () => {
      // 意図的に無視する。claimPromise の reject 側で結果を見る。
    });
    const claimerStore = new PostgresOutboxStore(claimerClient.db);

    let caughtError: unknown;
    try {
      // pg_backend_pid() を先に踏んで、claimer 側の接続の PID を掴む
      // （max: 1 なので同じ接続が使い回される）。
      const pidResult = await claimerClient.pool.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const claimerPid = pidResult.rows[0]?.pid;
      expect(claimerPid).toBeDefined();

      const claimPromise = claimerStore
        .claimBatch(ctx, {
          limit: 10,
          now: new Date(),
          claimedBy: "rollback-claimer-conn-drop",
          leaseMs: 60_000,
        })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      // テーブルロック待ちで実際にブロックしている状態を作ってから backend を切る。
      await new Promise((resolve) => setTimeout(resolve, 300));
      await pool.query("SELECT pg_terminate_backend($1)", [claimerPid]);

      caughtError = await claimPromise;
    } finally {
      // 共有プールで outbox を読む前に、必ずロックを手放す（doc コメント参照）。
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await closePostgresClient(claimerClient).catch(() => {});
    }

    expect(caughtError).toBeDefined();

    const stateBeforeRecovery = await readClaimState(jobId);
    expect(stateBeforeRecovery.claimed_at).toBeNull();
    expect(stateBeforeRecovery.attempts).toBe(0);

    const store = new PostgresOutboxStore((await getTestClient()).db);
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "recovery-claimer-2",
      leaseMs: 60_000,
    });
    expect(claimed.map((j) => j.id)).toContain(jobId);
    const stateAfter = await readClaimState(jobId);
    expect(stateAfter.claimed_at).not.toBeNull();
    expect(stateAfter.attempts).toBe(1);
  });
});
