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
import { assertQueryBigint, assertQueryDate, assertQueryTimestamptz } from "./query-check.js";
import { replaceLoneSurrogates } from "./well-formed-text.js";

/**
 * `OutboxStore` のインメモリ・プレースホルダ実装。`jobs` 配列は共有参照で渡す
 * （`InMemoryMemoryStore.outboxJobs` と同じ配列を渡すと、積まれたジョブをここから claim/complete/fail できる）。
 *
 * `claimBatch` のリース意味論、`complete`/`fail` の CAS 意味論（`attempts` が `expectedAttempts` と一致しなければ
 * {@link OutboxLeaseConflictError}）は `PostgresOutboxStore` と一致させてある。適合テストが両方に同じ歯を走らせるため、食い違うと歯が嘘をつく。
 *
 * 終端は先勝ち: `complete`/`fail` は互いに排他で、同種の再呼び出しも、先に付いた `completedAt`／`failedAt`・`lastError` を保つ
 * （後から来た呼び出しは行を変えず、例外も投げない）。
 * 取り直し（リースが切れた行の再 claim）では `availableAt` を `opts.now` へ進め、初めての claim では変えない。
 */
export class InMemoryOutboxStore implements OutboxStore {
  constructor(private readonly jobs: OutboxJobRecord[]) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    assertWellFormedCtx(ctx);
    // 負数は常に断る: `slice` の負数は「末尾から数えた除外」になり、ジョブを黙って claim してしまう。
    // Postgres は `LIMIT` が評価されたときだけ拒む（外側が0行だと評価されない）が、この fixture は行の有無に関わらず断る。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`claimBatch: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`claimBatch: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値も Postgres は拒む。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`claimBatch: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // `now` か `now - leaseMs` が Invalid Date になる入力は、Postgres がクエリの時点で拒む。検査せず数のまま比べると、未 claim のジョブを claim してしまう。
    // `now` が Invalid Date なら `now - leaseMs` もそうなので、1つの検査で両方を見る。
    if (Number.isNaN(new Date(opts.now.getTime() - opts.leaseMs).getTime())) {
      throw new Error(
        `claimBatch: now - leaseMs must be a valid Date (now=${opts.now.getTime()}, leaseMs=${opts.leaseMs})`,
      );
    }
    // `claimed_by` は `text` 列。Postgres は claim する行が無くても NUL を拒む。
    if (opts.claimedBy.includes("\u0000")) {
      throw new Error("claimBatch: claimedBy must not contain NUL characters (U+0000)");
    }
    // 孤立サロゲートは、Postgres では U+FFFD に置き換わる。
    const claimedByStored = replaceLoneSurrogates(opts.claimedBy);
    const kindsFilter = opts.kinds?.map((kind) => replaceLoneSurrogates(kind));
    // リースが切れたとみなす境界。`PostgresOutboxStore` と同じ `<=`（両端含む）。
    const leaseExpiresBefore = opts.now.getTime() - opts.leaseMs;
    const eligible = this.jobs.filter((job) => {
      const claimedAt = job.claimedAt ?? null;
      return (
        job.tenantId === ctx.tenantId &&
        (kindsFilter === undefined || (kindsFilter.length > 0 && kindsFilter[0] === job.kind)) &&
        (job.completedAt ?? null) === null &&
        (job.failedAt ?? null) === null &&
        job.availableAt <= opts.now &&
        // claim されたことが無い、またはリースが切れている。
        (claimedAt === null || claimedAt.getTime() <= leaseExpiresBefore)
      );
    });
    eligible.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
    const claimed = eligible.slice(0, opts.limit);
    for (const job of claimed) {
      // 取り直しなら `availableAt` を `opts.now` へ書き直す（`CASE WHEN o.claimed_at IS NULL THEN o.available_at ELSE now END` と同じ）。
      // `job.claimedAt` はこのループがまだ書き換えていない更新前の値。
      const isReclaim = (job.claimedAt ?? null) !== null;
      if (isReclaim) {
        job.availableAt = new Date(opts.now);
      }
      // 呼び手の `now` と同じ Date を保存しない。
      job.claimedAt = new Date(opts.now);
      job.claimedBy = claimedByStored;
      job.attempts += 1;
    }
    return claimed.map((job) => structuredClone(job));
  }

  async complete(
    ctx: Ctx,
    jobId: string,
    expectedAttempts: number,
    opts?: { at?: Date | undefined },
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // Invalid Date は Postgres が行の有無に関わらず拒むので、探す前に拒む。
    assertQueryTimestamptz("complete", "opts.at", opts?.at);
    // 大文字小文字は区別しない（Postgres は uuid 型の列で比べる）。
    const job = this.jobs.find((j) => j.id === jobId.toLowerCase() && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // 相手側の終端（fail）が付いていても、同種の終端が付いていても、先に付いた終端を勝たせる。
    if ((job.failedAt ?? null) !== null || (job.completedAt ?? null) !== null) {
      return;
    }
    // 省略時は壁時計。呼び手の `at` と同じ Date を保存しない。
    job.completedAt = opts?.at ? new Date(opts.at) : new Date();
  }

  async fail(
    ctx: Ctx,
    jobId: string,
    error: string,
    expectedAttempts: number,
    opts?: { at?: Date | undefined },
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // `complete` と同じ理由。
    assertQueryTimestamptz("fail", "opts.at", opts?.at);
    // 大文字小文字は区別しない（Postgres は uuid 型の列で比べる）。
    const job = this.jobs.find((j) => j.id === jobId.toLowerCase() && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // 相手側の終端（complete）が付いていても、同種の終端が付いていても、先に付いた終端を勝たせる。
    if ((job.completedAt ?? null) !== null || (job.failedAt ?? null) !== null) {
      return;
    }
    // 省略時は壁時計。`availableAt` の再計算はしない。呼び手の `at` と同じ Date を保存しない。
    job.failedAt = opts?.at ? new Date(opts.at) : new Date();
    // Postgres の `text` は NUL を保存できないので、`PostgresOutboxStore.fail` と同じく6文字の `\u0000` へ置き換える。
    job.lastError = error.replaceAll("\u0000", "\\u0000");
  }

  /**
   * このテナントの `jobs`（完了・失敗・未処理を問わず）を、`opts.limit` を目安に消す。
   * `this.jobs` は共有配列なので `splice` でその場から取り除く（差し替えると共有が壊れる）。
   * `reachedLimit` は削除した件数が `opts.limit` ちょうどかだけで決める（ちょうど使い切ると、残りが無くても `true`）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    // `limit` は `bigint` の引数へ渡される。
    assertQueryBigint("eraseTenant", "limit", opts.limit);
    const matchingIndexes: number[] = [];
    for (let i = 0; i < this.jobs.length && matchingIndexes.length < opts.limit; i++) {
      if (this.jobs[i]!.tenantId === ctx.tenantId) {
        matchingIndexes.push(i);
      }
    }
    if (!opts.dryRun) {
      // 後ろから splice する: 前からだと後続のインデックスがずれる。
      for (let i = matchingIndexes.length - 1; i >= 0; i--) {
        this.jobs.splice(matchingIndexes[i]!, 1);
      }
    }
    return { deleted: matchingIndexes.length, reachedLimit: matchingIndexes.length === opts.limit };
  }

  /** `completedAt` が付いていて `< olderThan` の行だけを消す（claim 中・未処理・`failedAt` の行は対象外）。共有配列なので `splice` でその場から取り除く。 */
  async purgeCompletedJobs(
    ctx: Ctx,
    opts: PurgeCompletedJobsOptions,
  ): Promise<PurgeCompletedJobsResult> {
    assertWellFormedCtx(ctx);
    assertQueryDate("purgeCompletedJobs", "olderThan", opts.olderThan);
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`purgeCompletedJobs: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`purgeCompletedJobs: limit must not be negative (got ${opts.limit})`);
    }
    if (opts.limit >= 2 ** 63) {
      throw new Error(
        `purgeCompletedJobs: limit must fit in a Postgres bigint (got ${opts.limit})`,
      );
    }
    const dryRun = opts.dryRun ?? false;
    const candidates = this.jobs
      .filter(
        (job) =>
          job.tenantId === ctx.tenantId &&
          (job.completedAt ?? null) !== null &&
          job.completedAt!.getTime() < opts.olderThan.getTime(),
      )
      .sort(
        (a, b) =>
          a.completedAt!.getTime() - b.completedAt!.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const reachedLimit = candidates.length > opts.limit;
    const victims = candidates.slice(0, opts.limit);
    const purged = victims.length;
    const oldestPurgedAt = purged > 0 ? new Date(victims[0]!.completedAt!) : null;
    const newestPurgedAt = purged > 0 ? new Date(victims[purged - 1]!.completedAt!) : null;
    if (!dryRun && purged > 0) {
      const victimIds = new Set(victims.map((job) => job.id));
      for (let i = this.jobs.length - 1; i >= 0; i--) {
        if (victimIds.has(this.jobs[i]!.id)) this.jobs.splice(i, 1);
      }
    }
    return { purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
  }
}
