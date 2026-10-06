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
 * `OutboxStore` の Postgres 実装（roadmap.md 段階3、ADR 0005 の transactional outbox
 * 「運搬役」側）。
 *
 * `claimBatch` は `FOR UPDATE SKIP LOCKED` を使う。複数のワーカーが同時に `tick()` を
 * 呼んでも、同じ行を二重に claim しない。
 *
 * 🔴 **この2つの節は別々の仕事をしている。「`SKIP LOCKED` が在るから二重 claim は安全」と
 * 読まないこと。**
 *
 * - **二重 claim を止めているのは `FOR UPDATE` の行ロックである。** READ COMMITTED 下では、
 *   ロック待ちで止まった側はロックの解放後に行を再フェッチして `WHERE` を再評価する。
 *   先に claim した側が書いた `claimed_at` がそこで見えるため、その行は候補から外れる。
 * - **`SKIP LOCKED` が足しているのは「詰まらないこと」だけである。** 既に他のワーカーが
 *   取ろうとしている行を待たずにスキップし、次の行を取りに行く。
 *
 * 【実測】2026-09-17、`main` = `cd4d812`。手元の Postgres 17 に対し、**接続を温めた**
 * `pg.Pool`（既定 `max=10`）上で「claim 可能なジョブ1本・`limit=1`・8並行」を10ラウンド撃った:
 *
 * - `FOR UPDATE SKIP LOCKED` を**丸ごと削る**と、**10ラウンド中8ラウンドで二重 claim**
 *   （8ワーカー全員が同じ job id を返した）。
 * - `SKIP LOCKED` **だけ**を外して `FOR UPDATE` にすると、**10ラウンドとも二重 claim なし。**
 *   ⟹ `SKIP LOCKED` を外しても正しさは壊れない。
 *
 * ⚠ **`SKIP LOCKED` が実際に詰まりを減らすことは測っていない。** 上が見ているのは正しさ側
 * だけであり、「詰まらないこと」は機構からの推論である。
 *
 * 🔴 **上の ⚠ は ADR 0208 が埋めた。** `outbox-skip-locked-non-blocking.postgres.test.ts`
 * が、`claimBatch` を直接呼んで「詰まらないこと」を肯定側で検査する
 * ——外部トランザクションが唯一の候補行の行ロックを保持したまま、`lock_timeout=100ms`
 * を積んだ専用クライアントで撃ち、例外を投げずに0件で解決することを見る。
 * `SKIP LOCKED` を外すとこの歯は `55P03`（canceling statement due to lock timeout）
 * で赤くなる（変異試験は ADR 0208「測ったこと」参照）。
 * ⚠ ただし、この歯が測っているのは「ロックが在るときにブロックせず抜けられるか」という
 * *機構*であって、**実運用の throughput（単位時間あたりに何件捌けるか）そのものは、
 * この歯も含めていまだ測っていない。**
 * ⚠ **接続を温めていない `pg.Pool` に対しては、`FOR UPDATE SKIP LOCKED` を丸ごと削っても
 * 二重 claim が再現しない**【実測、同日】——遅延接続のため `Promise.all` の各呼び出しが接続
 * 確立でずれ、競争の窓が閉じる。⟹ **この振る舞いを検査する歯を書くときは、先に
 * `pool.query` を並行数ぶん撃って接続を張ること。**張らないと、歯が無くても緑になる。
 * ⚠ **10ラウンドで出なかったことは、起きないことの証明ではない。**
 *
 * 🔴 **ただし `FOR UPDATE SKIP LOCKED` の行ロックは、この SQL 文の実行（コミット）が
 * 終わった瞬間に解放される。** 「claim した」こと自体は `claimed_at`/`claimed_by` という
 * 列の値としてしか残らない。そのため `claimBatch` の `WHERE` は `claimed_at` を
 * 単に `IS NULL` で見るのではなく、**リース（ADR 0032）**——`claimed_at` が無いか、
 * `leaseMs` 以上前——で見る。`claimed_at IS NULL` だけにすると、claim 後に処理が
 * 終わらないまま止まったワーカーのジョブが `completed_at`/`failed_at` のどちらも
 * 付かないまま二度と claim されなくなる（「見えない停止」）。詳細は
 * `packages/core/src/interfaces/outbox-store.ts` の doc と ADR 0032。
 *
 * 🔴 **`complete`/`fail` は CAS（ADR 0142, Issue #233）**——`attempts` 列が呼び出し側の
 * `expectedAttempts` と一致する行だけを更新する。リースが切れて別のワーカーに再 claim
 * された後、遅れて戻ってきた古いワーカーが `complete`/`fail` を呼んでも、新しいワーカーが
 * 既に書いた終端状態を黙って上書きしない——`attempts` が一致しなければ
 * `OutboxLeaseConflictError` を投げる。詳細は `packages/core/src/interfaces/outbox-store.ts`
 * の doc と ADR 0142。
 *
 * 🔴 **`complete`/`fail` は互いに排他でもある（Issue #826）**——`attempts` が一致しても、
 * 相手側の終端列（`completed_at`/`failed_at`）が既に付いていれば `UPDATE` の `WHERE` は
 * 対象を0行にする。先に付いた終端が勝ち、後から来た呼び出しは行を変えず、例外も投げない
 * （無言の no-op）。同じ `attempts` のまま complete → fail（逐次でも並行でも）を呼んでも、
 * `completed_at`/`failed_at` の両方が付くことはない。
 *
 * 🔴 **終端は先勝ち（ADR 0440）**——同じ `attempts` のまま同種（complete → complete、fail → fail）を
 * 呼んでも、1回目の `completed_at`／`failed_at`・`last_error` を保つ（2回目の `at`・`error` は捨てる。
 * `purgeCompletedJobs` の `completed_at < olderThan` の境界も1回目で決まる）。`UPDATE` の `WHERE` は
 * `completed_at IS NULL AND failed_at IS NULL` の両方を見る。戻り値（`void`）と例外は変わらない
 * （`attempts` 不一致だけが `OutboxLeaseConflictError`、それ以外の再呼び出しは無言の no-op）。
 *
 * 🔴 **2026-09-29 追記（[Issue #1196](https://github.com/takecchi/mnemora/issues/1196)、
 * [ADR 0357](../../../docs/decisions/0357-outbox-reclaim-requeues-to-tail.md)。クローン miku
 * の判断であり、オーナーの判断ではない）: 取り直し（`claimed_at` が既に非 NULL の行を再び
 * claim する場合）は `available_at` を `opts.now` へ書き直す。** `claimBatch` の `UPDATE`
 * の `SET` は `available_at = CASE WHEN o.claimed_at IS NULL THEN o.available_at ELSE
 * ${now} END` という形で、初めての claim（`claimed_at IS NULL`）では `available_at` を
 * 変えず、取り直しでは `now` に進める。**`SET` 句の中の `o.claimed_at` は、この `UPDATE`
 * 自身が今まさに書こうとしている新しい値ではなく、この行の更新前の値である**
 * （PostgreSQL は同一 `UPDATE` 文の `SET` 内で他列を右辺に使うとき、常に更新前の値を見る）。
 * 詳細・狙い・採らなかった案は `packages/core/src/interfaces/outbox-store.ts` の同日付追記
 * と ADR 0357。
 */
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly db: Db) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    assertWellFormedCtx(ctx);
    const kindsFilter =
      opts.kinds !== undefined ? sql`AND kind = ANY(${sql.param(opts.kinds)}::text[])` : sql``;
    // リースが切れたとみなす境界時刻。`claimed_at <= leaseExpiresBefore` の行は
    // 「十分前に claim されたまま完了していない」＝止まったワーカーの行とみなす。
    // 境界は `available_at <= opts.now` と同じ `<=`（両端含む）に揃えてある。
    const leaseExpiresBefore = new Date(opts.now.getTime() - opts.leaseMs);
    // ADR 0547: `now` と `now - leaseMs` は、`timestamptz` の下限より前でも落ちないよう、下限へ寄せてから比べる。
    // 行に書く値（`claimed_at`・`available_at`）も同じ寄せた値にする——寄せずに書くと、比べる側が通した行の UPDATE が `22008` になる。
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
    // ADR 0594: `opts.at` の Invalid Date は、`jobId` の形・行の有無より先に断る（testkit の fixture・core の Fake と同じ順）。
    // 下の `jobId` の形の検査は静かに返るので、先に見ないと、呼び手のバグが黙って通る。
    assertValidDate("complete", "opts.at", opts?.at);
    // ADR 0597: 下限（`timestamptz` の紀元前4714年）より前も、同じく `jobId` の形より先に断る（`RangeError`。testkit の fixture と同じ型・文面）。
    assertNotBelowTimestamptzMin("complete", "opts.at", opts?.at);
    // id 列は uuid 型。べき等な終端更新（存在しない/形式が不正な id でも例外を投げない）
    // という契約のため、UUID の形をしていない入力はここで静かに無視する
    // （実 DB 検査で判明: 素通しすると invalid input syntax for type uuid で例外になる）。
    if (!isUuidLike(jobId)) {
      return;
    }
    // Issue #1237: 省略時は壁時計。
    const completedAt = opts?.at ?? new Date();
    // Issue #826: 相手側の終端（fail）が既に付いていたら、この UPDATE は0行のまま
    // 何も書かない（`failed_at IS NULL` を WHERE に足す——先に付いた終端を勝たせる）。
    // ADR 0440: 同種の終端（complete）が既に付いていても同じ（`completed_at IS NULL` ——先勝ち。
    // 2回目の `at` で `completed_at` を上書きしない）。
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
    // ADR 0594: `complete` と同じ（`opts.at` の Invalid Date を、`jobId` の形より先に断る）。
    assertValidDate("fail", "opts.at", opts?.at);
    // ADR 0597: `complete` と同じ（下限より前を、`jobId` の形より先に断る）。
    assertNotBelowTimestamptzMin("fail", "opts.at", opts?.at);
    if (!isUuidLike(jobId)) {
      return;
    }
    // Postgres の `text` は NUL（U+0000）を保存できない（22021）。`error` には失敗した
    // クエリの params（利用者の本文）が入りうるので、LLM の出力に NUL が混ざると
    // この UPDATE そのものが落ち、ジョブが終端に落ちないまま `tick()` が投げていた。
    // 黙って消さず、目に見える6文字の `\u0000` に置き換えて書く。
    // 歯は `__tests__/outbox-fail-nul-last-error.postgres.test.ts`。
    const storableError = error.replaceAll("\u0000", "\\u0000");
    // Issue #1237: 省略時は壁時計。⚠ `available_at` は再計算しない（interface の doc 参照）。
    const failedAt = opts?.at ?? new Date();
    // Issue #826: 相手側の終端（complete）が既に付いていたら、この UPDATE は0行のまま
    // 何も書かない（`completed_at IS NULL` を WHERE に足す——先に付いた終端を勝たせる）。
    // ADR 0440: 同種の終端（fail）が既に付いていても同じ（`failed_at IS NULL` ——先勝ち。
    // 2回目の `at`・`error` で `failed_at`・`last_error` を上書きしない）。
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
   * `complete`/`fail` の CAS な `UPDATE` が0行だったときに呼ぶ（ADR 0142, Issue #233、
   * Issue #826）。**0行になる理由は3つあり、区別する**——(a) その id の行がそもそも
   * 存在しない（べき等な no-op、既存契約）、(b) 行は存在するが `attempts` が一致しない
   * （別のワーカーが既にこの行を再 claim している。{@link OutboxLeaseConflictError}）、
   * (c) 行は存在し `attempts` も一致するが、相手側の終端列が既に付いている
   * （Issue #826: 先に付いた終端が勝つ、無言の no-op、例外にしない）。
   *
   * (b) と (c) の区別は、読み直した `attempts` が `expectedAttempts` と一致するかで
   * 付く——`claimBatch` の `WHERE`（`completed_at IS NULL AND failed_at IS NULL`）は
   * 一度終端化された行を二度と対象にしないため、終端化された行の `attempts` は
   * その後永久に固定される（`packages/core/src/interfaces/outbox-store.ts` の doc
   * 「理由」節と同じ論法）。したがって `attempts` が一致するのに0行だったなら、
   * 唯一の残りの説明は「相手側の終端に弾かれた」（c）である。
   *
   * 読み直しと実際に条件が破れた瞬間の間にも別の claim が割り込む余地があるため、
   * (b) で投げる `observedAttempts` は「弾かれた瞬間の値」の保証ではない（ADR 0030 の
   * `MemoryStatusConflictError` と同じ限界、doc コメント参照）。
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
   * Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md):
   * `OutboxStore.eraseTenant?` の実装。`outbox` には他のテーブルからの FK が無く、
   * `outbox` 自身も他テーブルを参照しないので、`blocked_by_foreign_reference` 相当の
   * 検査は不要（`MemoryStore.eraseTenant` とは違う点）。`opts.limit` を目安に、完了・
   * 失敗・未処理を問わず削除する。
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
    // ADR 0430 決定2: 同じテナントへの同時呼び出しを直列にする（lock を取るためにトランザクションで包む）。
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
   * [ADR 0404](../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * `OutboxStore.purgeCompletedJobs?` の実装。`completed_at IS NOT NULL AND completed_at < olderThan`
   * の行**だけ**を消す——claim 中・未処理・`failed_at` が付いた行は、述語に `completed_at` が
   * 入っている限り対象にならない（`complete` と `fail` は互いに排他なので、`failed_at` の行に
   * `completed_at` は付かない）。対象を先に確定し（`FOR UPDATE SKIP LOCKED`）、その id だけを
   * 消す。
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
 * `purgeCompletedJobs` が消す対象の `outbox` の行を選ぶ SELECT
 * （`completed_at IS NOT NULL AND completed_at < opts.olderThan`、古い順に `opts.limit + 1` 件
 * ——上限に届いたかを判定するために1件多く取る）。`lock` が真なら `FOR UPDATE SKIP LOCKED` で
 * 行を掴む（削除するとき）。EXPLAIN の歯（`outbox-purge-index.test.ts`）がこの関数の返り値を測る。
 * 述語を `idx_outbox_completed`（migration 0032、`WHERE completed_at IS NOT NULL` の部分索引）の
 * 述語と揃えてある——ここを変えるときは索引も見直すこと。
 */
export function buildPurgeCompletedJobsTargetSelect(
  ctx: Ctx,
  opts: PurgeCompletedJobsOptions,
  lock = false,
): SQL {
  return sql`
    SELECT id, completed_at FROM outbox
    WHERE tenant_id = ${ctx.tenantId}
      AND completed_at < ${toPgTimestamp(opts.olderThan)}
    ORDER BY completed_at ASC, id ASC
    LIMIT ${opts.limit + 1}${lock ? sql` FOR UPDATE SKIP LOCKED` : sql``}`;
}
