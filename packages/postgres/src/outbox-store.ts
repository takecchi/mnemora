import { sql, type SQL } from "drizzle-orm";
import {
  OutboxLeaseConflictError,
  type ClaimOutboxJobsOptions,
  type Ctx,
  type EraseTenantResult,
  type EraseTenantStoreOptions,
  type OutboxJobRecord,
  type OutboxStore,
  type PurgeCompletedJobsOptions,
  type PurgeCompletedJobsResult,
} from "@mnemora/core";
import { assertWellFormedCtx } from "@mnemora/core";
import type { Db } from "./client.js";
import { assertNotBelowTimestamptzMin, assertValidDate } from "./input-check.js";
import { omittingParams } from "./omit-params.js";
import { lockTenantForErase } from "./erase-tenant-lock.js";
import {
  isUuidLike,
  parsePgTimestamp,
  rowToOutboxJob,
  isBeforePgTimestamptzMin,
  toPgTimestamp,
  toPgTimestampClamped,
  type OutboxJobRow,
} from "./mapping.js";

/**
 * `OutboxStore` の Postgres 実装（ADR 0005 の transactional outbox「運搬役」側）。
 *
 * **`claimBatch` の `FOR UPDATE` と `SKIP LOCKED` は別々の仕事をしている。「`SKIP LOCKED` が在るから二重 claim は
 * 安全」と読まないこと。**
 *
 * - 二重 claim を止めているのは `FOR UPDATE` の行ロックである。READ COMMITTED 下では、ロック待ちで止まった側は
 *   解放後に行を再フェッチして `WHERE` を再評価し、先に claim した側が書いた `claimed_at` が見えて候補から外れる。
 *   `FOR UPDATE SKIP LOCKED` を丸ごと削ると、接続を温めた並行実行で二重 claim が起きる。
 * - `SKIP LOCKED` が足すのは、他のワーカーが取ろうとしている行を待たずに次の行へ進む「詰まらないこと」だけで、
 *   外しても正しさは壊れない（ADR 0208）。
 *
 * 行ロックは、この SQL 文の実行（コミット）が終わった瞬間に解放され、「claim した」ことは `claimed_at`/`claimed_by`
 * の値としてしか残らない。そのため `claimBatch` の `WHERE` は `claimed_at IS NULL` だけでなく**リース**（ADR 0032。
 * `claimed_at` が無いか `leaseMs` 以上前）で見る。`IS NULL` だけにすると、claim 後に止まったワーカーのジョブが
 * 終端のどちらも付かないまま二度と claim されない。
 *
 * **`complete`/`fail` は CAS（ADR 0142）**: `attempts` が呼び出し側の `expectedAttempts` と一致する行だけを更新する。
 * リース切れで別のワーカーに再 claim された後に戻ってきた古いワーカーが、新しいワーカーの終端状態を上書きしない。
 * 一致しなければ `OutboxLeaseConflictError` を投げる。
 *
 * **`complete`/`fail` は互いに排他で、終端は先勝ちである（ADR 0440）**: `UPDATE` の `WHERE` は
 * `completed_at IS NULL AND failed_at IS NULL` の両方を見る。`attempts` が一致しても、どちらかの終端が既に付いていれば
 * 0行になり、後から来た呼び出しは行を変えず例外も投げない（無言の no-op）。同種の再呼び出しでも、2回目の
 * `at`・`error` は捨てて1回目の `completed_at`／`failed_at`・`last_error` を保つ。
 *
 * **取り直し**（`claimed_at` が既に非 NULL の行を再び claim する場合）は `available_at` を `opts.now` へ書き直す
 * （ADR 0357）。`claimBatch` の `SET` の `available_at = CASE WHEN o.claimed_at IS NULL ...` の `o.claimed_at` は、
 * この `UPDATE` が書こうとしている新しい値でなく、更新前の値である。
 */
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly db: Db) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    assertWellFormedCtx(ctx);
    const kindsFilter =
      opts.kinds !== undefined ? sql`AND kind = ANY(${sql.param(opts.kinds)}::text[])` : sql``;
    // `claimed_at <= leaseExpiresBefore` の行を、止まったワーカーの行とみなす。境界は `available_at <= opts.now` と同じ `<=`。
    const leaseExpiresBefore = new Date(opts.now.getTime() - opts.leaseMs);
    // `now` と `now - leaseMs` は、`timestamptz` の下限より前でも落ちないよう下限へ寄せてから比べる（ADR 0547）。
    // 行に書く値も同じ寄せた値にする。寄せずに書くと、比べる側が通した行の UPDATE が `22008` になる。
    const nowParam = toPgTimestampClamped(opts.now);

    const result = await omittingParams(() =>
      this.db.execute(sql`
      WITH claimable AS (
        SELECT id FROM outbox
        WHERE tenant_id = ${ctx.tenantId}
          AND completed_at IS NULL
          AND failed_at IS NULL
          AND available_at <= ${nowParam}
          AND (claimed_at IS NULL OR claimed_at <= ${toPgTimestampClamped(leaseExpiresBefore)})
          ${kindsFilter}
        ORDER BY available_at ASC
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox o
      SET claimed_at = ${nowParam}, claimed_by = ${opts.claimedBy}, attempts = attempts + 1,
        available_at = CASE WHEN o.claimed_at IS NULL THEN o.available_at ELSE ${nowParam} END
      FROM claimable c
      WHERE o.id = c.id
      RETURNING o.*
    `),
    );
    return result.rows.map((row) => rowToOutboxJob(row as unknown as OutboxJobRow));
  }

  async complete(
    ctx: Ctx,
    jobId: string,
    expectedAttempts: number,
    opts?: { at?: Date | undefined },
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // `opts.at` の不正な日時は、`jobId` の形・行の有無より先に断る（ADR 0594、ADR 0597）。
    // 下の `jobId` の形の検査は静かに返るので、先に見ないと呼び手のバグが黙って通る。
    assertValidDate("complete", "opts.at", opts?.at);
    assertNotBelowTimestamptzMin("complete", "opts.at", opts?.at);
    // べき等な終端更新（存在しない/形式が不正な id でも例外を投げない）という契約のため、UUID の形でない入力は静かに無視する。
    if (!isUuidLike(jobId)) {
      return;
    }
    const completedAt = opts?.at ?? new Date();
    // 相手側の終端が既に付いていたら、この UPDATE は0行のまま何も書かない（先に付いた終端を勝たせる）。
    const result = await omittingParams(() =>
      this.db.execute(sql`
      UPDATE outbox
      SET completed_at = ${toPgTimestamp(completedAt)}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId} AND attempts = ${expectedAttempts}
        AND failed_at IS NULL AND completed_at IS NULL
      RETURNING id
    `),
    );
    if (result.rows.length > 0) {
      return;
    }
    await this.raiseIfLeaseConflict(ctx, jobId, expectedAttempts);
  }

  async fail(
    ctx: Ctx,
    jobId: string,
    error: string,
    expectedAttempts: number,
    opts?: { at?: Date | undefined },
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // `complete` と同じ（`opts.at` の不正な日時を、`jobId` の形より先に断る）。
    assertValidDate("fail", "opts.at", opts?.at);
    assertNotBelowTimestamptzMin("fail", "opts.at", opts?.at);
    if (!isUuidLike(jobId)) {
      return;
    }
    // Postgres の `text` は NUL を保存できない（22021）。`error` には失敗したクエリの params（利用者の本文）が入りうるので、
    // LLM の出力に NUL が混ざると、この UPDATE が落ちてジョブが終端に落ちない。黙って消さず、見える `\u0000` に置き換える。
    const storableError = error.replaceAll("\u0000", "\\u0000");
    // `available_at` は再計算しない（interface の doc 参照）。
    const failedAt = opts?.at ?? new Date();
    const result = await omittingParams(() =>
      this.db.execute(sql`
      UPDATE outbox
      SET failed_at = ${toPgTimestamp(failedAt)}, last_error = ${storableError}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId} AND attempts = ${expectedAttempts}
        AND completed_at IS NULL AND failed_at IS NULL
      RETURNING id
    `),
    );
    if (result.rows.length > 0) {
      return;
    }
    await this.raiseIfLeaseConflict(ctx, jobId, expectedAttempts);
  }

  /**
   * `complete`/`fail` の CAS な `UPDATE` が0行だったときに呼ぶ。0行になる理由は3つあり、区別する。
   * (a) 行が存在しない（べき等な no-op）、(b) `attempts` が一致しない（別のワーカーが再 claim している。
   * {@link OutboxLeaseConflictError}）、(c) `attempts` は一致するが、相手側の終端列が既に付いている（無言の no-op）。
   *
   * (b) と (c) は、読み直した `attempts` で区別する。`claimBatch` は終端化された行を二度と対象にしないので、
   * 終端化された行の `attempts` は固定される。一致するのに0行なら、残る説明は (c) だけである。
   *
   * 読み直しと条件が破れた瞬間の間にも別の claim が割り込みうるので、(b) の `observedAttempts` は「弾かれた瞬間の値」の
   * 保証ではない（ADR 0030 の `MemoryStatusConflictError` と同じ限界）。
   */
  private async raiseIfLeaseConflict(
    ctx: Ctx,
    jobId: string,
    expectedAttempts: number,
  ): Promise<void> {
    const current = await omittingParams(() =>
      this.db.execute(sql`
      SELECT attempts FROM outbox WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
    `),
    );
    const row = current.rows[0] as { attempts: number } | undefined;
    if (row === undefined) {
      // 行が無い（既に存在しない/最初から無い）。べき等な no-op のまま、例外にしない。
      return;
    }
    if (row.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, row.attempts);
    }
    // attempts は一致している——相手側の終端列に弾かれた（Issue #826）。無言の no-op。
  }

  /**
   * `OutboxStore.eraseTenant?` の実装（ADR 0383）。`outbox` には他のテーブルからの FK が無く、自身も他テーブルを
   * 参照しないので、`blocked_by_foreign_reference` 相当の検査は不要（`MemoryStore.eraseTenant` との違い）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    if (opts.dryRun === true) {
      const result = await omittingParams(() =>
        this.db.execute(sql`
        SELECT count(*)::int AS count FROM (
          SELECT 1 FROM outbox WHERE tenant_id = ${ctx.tenantId} LIMIT ${opts.limit}
        ) s
      `),
      );
      const deleted = (result.rows[0] as unknown as { count: number }).count;
      return { deleted, reachedLimit: deleted === opts.limit };
    }
    // 同じテナントへの同時呼び出しを直列にする（ADR 0430）。
    const deleted = await omittingParams(() =>
      this.db.transaction(async (tx) => {
        await lockTenantForErase(tx, ctx.tenantId);
        const result = await tx.execute(sql`
        WITH victims AS (
          SELECT id FROM outbox WHERE tenant_id = ${ctx.tenantId} LIMIT ${opts.limit}
        )
        DELETE FROM outbox o
        USING victims v
        WHERE o.tenant_id = ${ctx.tenantId} AND o.id = v.id
        RETURNING o.id
      `);
        return result.rows.length;
      }),
    );
    return { deleted, reachedLimit: deleted === opts.limit };
  }

  /**
   * `OutboxStore.purgeCompletedJobs?` の実装（ADR 0404）。`completed_at IS NOT NULL AND completed_at < olderThan` の行
   * **だけ**を消す（claim 中・未処理・`failed_at` が付いた行は対象にならない）。対象を先に確定し
   * （`FOR UPDATE SKIP LOCKED`）、その id だけを消す。
   */
  async purgeCompletedJobs(
    ctx: Ctx,
    opts: PurgeCompletedJobsOptions,
  ): Promise<PurgeCompletedJobsResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun ?? false;
    if (isBeforePgTimestamptzMin(opts.olderThan)) {
      return { purged: 0, reachedLimit: false, oldestPurgedAt: null, newestPurgedAt: null, dryRun };
    }
    const olderThan = toPgTimestamp(opts.olderThan);
    if (dryRun) {
      const candidates = await omittingParams(() =>
        this.db.execute(buildPurgeCompletedJobsTargetSelect(ctx, opts, false)),
      );
      const rows = candidates.rows as unknown as { completed_at: string }[];
      const victims = rows.slice(0, opts.limit);
      return {
        purged: victims.length,
        reachedLimit: rows.length > opts.limit,
        oldestPurgedAt: victims.length > 0 ? parsePgTimestamp(victims[0]!.completed_at) : null,
        newestPurgedAt:
          victims.length > 0 ? parsePgTimestamp(victims[victims.length - 1]!.completed_at) : null,
        dryRun,
      };
    }
    return omittingParams(() =>
      this.db.transaction(async (tx) => {
        const candidates = await tx.execute(buildPurgeCompletedJobsTargetSelect(ctx, opts, true));
        const rows = candidates.rows as unknown as { id: string; completed_at: string }[];
        const reachedLimit = rows.length > opts.limit;
        const victimIds = rows.slice(0, opts.limit).map((row) => row.id);
        if (victimIds.length === 0) {
          return { purged: 0, reachedLimit, oldestPurgedAt: null, newestPurgedAt: null, dryRun };
        }
        // 述語をもう一度書く: 消すのは、確定した id のうち今も完了済みの行だけ。
        const deleted = await tx.execute(sql`
        DELETE FROM outbox
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${sql.param(victimIds)}::uuid[])
          AND completed_at IS NOT NULL AND completed_at < ${olderThan}
        RETURNING completed_at
      `);
        const completedAts = (deleted.rows as unknown as { completed_at: string }[])
          .map((row) => parsePgTimestamp(row.completed_at))
          .sort((a, b) => a.getTime() - b.getTime());
        return {
          purged: completedAts.length,
          reachedLimit,
          oldestPurgedAt: completedAts.length > 0 ? completedAts[0]! : null,
          newestPurgedAt: completedAts.length > 0 ? completedAts[completedAts.length - 1]! : null,
          dryRun,
        };
      }),
    );
  }
}

/**
 * `purgeCompletedJobs` が消す対象の行を選ぶ SELECT。古い順に `opts.limit + 1` 件取り（上限に届いたかを判定するため）、
 * `lock` が真なら `FOR UPDATE SKIP LOCKED` で行を掴む。述語は `idx_outbox_completed`（`WHERE completed_at IS NOT NULL` の
 * 部分索引）の述語と揃えてある。ここを変えるときは索引も見直すこと。
 */
export function buildPurgeCompletedJobsTargetSelect(
  ctx: Ctx,
  opts: PurgeCompletedJobsOptions,
  lock = false,
): SQL {
  return sql`
    SELECT id, completed_at FROM outbox
    WHERE tenant_id = ${ctx.tenantId}
      AND completed_at IS NOT NULL AND completed_at < ${toPgTimestamp(opts.olderThan)}
    ORDER BY completed_at ASC, id ASC
    LIMIT ${opts.limit + 1}${lock ? sql` FOR UPDATE SKIP LOCKED` : sql``}`;
}
