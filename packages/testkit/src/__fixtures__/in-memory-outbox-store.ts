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

/**
 * `OutboxStore` のインメモリ・プレースホルダ実装（roadmap.md 段階3）。
 *
 * `jobs` 配列は呼び出し側から共有参照として渡される想定
 * （`InMemoryMemoryStore.outboxJobs` と同じ配列を渡すことで、`createObservationWithOutbox` /
 * `createMemoryWithOutbox` が積んだジョブをここから claim/complete/fail できる）。
 *
 * `claimBatch` のリース意味論（ADR 0032）は `PostgresOutboxStore` と一致させてある
 * ——`packages/testkit` の適合テスト（`outbox-store-conformance.ts`）が両方の実装に
 * 対して同じ歯を走らせるため、ここで食い違うと歯が嘘をつく。
 *
 * `complete`/`fail` の CAS 意味論（ADR 0142, Issue #233）も同じ理由で一致させてある
 * ——`attempts` が `expectedAttempts` と一致する行だけを更新し、一致しなければ
 * {@link OutboxLeaseConflictError} を投げる。
 *
 * `complete`/`fail` は互いに排他でもある（Issue #826）——相手側の終端列
 * （`completedAt`/`failedAt`）が既に付いていれば、後から来た呼び出しは行を一切変えず
 * 例外も投げない（先に付いた終端が勝つ）。
 *
 * 🔴 **終端は先勝ち（ADR 0440）**——同種の再呼び出し（complete+complete、fail+fail）も、同じ
 * `attempts` なら1回目の `completedAt`／`failedAt`・`lastError` を保つ（2回目の `at`・`error` は
 * 捨てる）。戻り値（`void`）と例外は変わらない。`PostgresOutboxStore` の `UPDATE` の条件
 * （`completed_at IS NULL AND failed_at IS NULL`）と一致させてある。
 *
 * 2026-09-29 追記（[Issue #1196](https://github.com/takecchi/mnemora/issues/1196)、
 * [ADR 0357](../../../../docs/decisions/0357-outbox-reclaim-requeues-to-tail.md)。クローン
 * miku の判断であり、オーナーの判断ではない）——取り直し（リースが切れた行の再 claim）の
 * `availableAt` 更新も `PostgresOutboxStore` と一致させてある。初めての claim では
 * `availableAt` を変えず、取り直しでは `opts.now` へ進める（`claimBatch` 内の該当コメント
 * 参照）。
 */
export class InMemoryOutboxStore implements OutboxStore {
  constructor(private readonly jobs: OutboxJobRecord[]) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    assertWellFormedCtx(ctx);
    // `PostgresOutboxStore` は `limit` を生 SQL の `LIMIT` にそのまま渡すため、負数を
    // 渡すと、`LIMIT` が評価されたときに Postgres 自身が `LIMIT must not be negative`
    // （2201W）で例外を投げ、その文は何も書かない。⚠ ただし**評価されなければ投げない**
    // ——`claimable`（CTE）が結合の内側に回り、外側の `outbox` が0行だと、内側の `LIMIT` は
    // 一度も評価されない（プランナの統計しだい。空の表を `ANALYZE` して `reltuples = 0`
    // の状態など。ADR 0575 の実測）。撃つテナントの行が表に1本でもあれば、外側が空に
    // ならないので、どの統計の状態でも投げた（ADR 0575、`store-boundary-diff` の
    // `claimBatch(limit:-1)` の実測）。この fixture は、行の有無に関わらず常に断る。
    // ここで同じ入力を検査せずに `eligible.slice(0, opts.limit)` へ渡すと、
    // `Array.prototype.slice` の負数引数は「末尾から数えた除外」という別の意味になり、
    // ジョブを黙って claim してしまう（このクラスの doc が明言する「`PostgresOutboxStore`
    // と一致させてある」という意図に反する）。Postgres が拒む入力（行があるとき）に
    // 揃え、副作用が起きる前に例外を投げる。
    //
    // ⚠ 負数だけでは足りない——`LIMIT` の SQL パラメータは bigint 型であり、`NaN`/
    // `Infinity`/非整数を渡すと Postgres は `invalid input syntax for type bigint: "NaN"`
    // の形で例外を投げる（実測済み。in-memory-vector-store.ts の同種の注記参照）。
    // 既存の「負数」ガード（上の段落）とは別の例外メッセージにして、PR #811 が固定した
    // 「負数は例外」の回帰テストの文言を変えずに済ませる。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`claimBatch: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`claimBatch: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`claimBatch: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // `PostgresOutboxStore.claimBatch` は `now` と `new Date(now - leaseMs)` を `timestamptz`
    // のパラメータとして送るため、どちらかが Invalid Date になる入力（`now` が Invalid Date、
    // `leaseMs` が `NaN`・`±Infinity`・`Date` の範囲を超える値）では Postgres が例外を投げる
    // （実測: `invalid input syntax for type timestamp with time zone`）。ここで検査せず数の
    // まま比べると、未 claim のジョブを claim してしまう。クエリを投げる前に弾く Postgres 側に
    // 揃える。⚠ `Date` としては有効でも Postgres の範囲（紀元前4714年より前）を外れる値は
    // 揃えていない（Issue #1041 の論点）。`now` が Invalid Date なら `now - leaseMs` も
    // Invalid Date になるので、1つの検査で両方を見る。
    if (Number.isNaN(new Date(opts.now.getTime() - opts.leaseMs).getTime())) {
      throw new Error(
        `claimBatch: now - leaseMs must be a valid Date (now=${opts.now.getTime()}, leaseMs=${opts.leaseMs})`,
      );
    }
    // `claimed_by` は `text` 列。Postgres は NUL を含む値をパラメータの時点で拒む（claim する行が
    // 無くても）。検査せずに進めると、ジョブを claim して NUL を含む名前を書いてしまう。
    if (opts.claimedBy.includes("\u0000")) {
      throw new Error("claimBatch: claimedBy must not contain NUL characters (U+0000)");
    }
    // リースが切れたとみなす境界時刻。`PostgresOutboxStore` と同じ `<=`（両端含む）。
    const leaseExpiresBefore = opts.now.getTime() - opts.leaseMs;
    const eligible = this.jobs.filter((job) => {
      const claimedAt = job.claimedAt ?? null;
      return (
        job.tenantId === ctx.tenantId &&
        (opts.kinds === undefined || opts.kinds.includes(job.kind)) &&
        (job.completedAt ?? null) === null &&
        (job.failedAt ?? null) === null &&
        job.availableAt <= opts.now &&
        // claim されたことが無い、またはリースが切れている（ADR 0032）。
        (claimedAt === null || claimedAt.getTime() <= leaseExpiresBefore)
      );
    });
    eligible.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
    const claimed = eligible.slice(0, opts.limit);
    for (const job of claimed) {
      // 2026-09-29 追記（Issue #1196、ADR 0357）: 取り直し（この行が既に claim されたことが
      // ある＝ `claimedAt` が非 null）なら、`availableAt` を `opts.now` へ書き直す。初めての
      // claim（`claimedAt` が null だった）では `availableAt` を変えない。`PostgresOutboxStore`
      // の `CASE WHEN o.claimed_at IS NULL THEN o.available_at ELSE now END` と同じ意味論——
      // ここで見る `job.claimedAt` は、この for ループがまだ書き換えていない「更新前」の値。
      // `claimedAt` は省略可（`undefined`）。上の絞り込みと同じく `?? null` で読む。
      const isReclaim = (job.claimedAt ?? null) !== null;
      if (isReclaim) {
        job.availableAt = new Date(opts.now);
      }
      // Issue #1108: 呼び手の `now` と同じ Date を保存しない。
      job.claimedAt = new Date(opts.now);
      job.claimedBy = opts.claimedBy;
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
    // `PostgresOutboxStore.complete` は `at` を `timestamptz` として送るため、Invalid Date は行の有無に
    // 関わらずクエリの時点で拒まれる（`22007`）。同じ入力を、探す前に拒む。
    assertQueryTimestamptz("complete", "opts.at", opts?.at);
    // ADR 0521: ジョブ id の大文字小文字は区別しない（`@mnemora/postgres` は uuid 型の列で比べる。この fixture の id は小文字）。
    const job = this.jobs.find((j) => j.id === jobId.toLowerCase() && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（fail）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    // ADR 0440: 同種の終端（complete）が既に付いていても同じ——先勝ち（`completedAt` を上書きしない）。
    if ((job.failedAt ?? null) !== null || (job.completedAt ?? null) !== null) {
      return;
    }
    // Issue #1237: 省略時は壁時計。Issue #1108: 呼び手の `at` と同じ Date を保存しない。
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
    // `complete` と同じ理由（Invalid Date は Postgres が `22007` で拒む）。
    assertQueryTimestamptz("fail", "opts.at", opts?.at);
    // ADR 0521: ジョブ id の大文字小文字は区別しない（`@mnemora/postgres` は uuid 型の列で比べる。この fixture の id は小文字）。
    const job = this.jobs.find((j) => j.id === jobId.toLowerCase() && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（complete）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    // ADR 0440: 同種の終端（fail）が既に付いていても同じ——先勝ち（`failedAt`・`lastError` を上書きしない）。
    if ((job.completedAt ?? null) !== null || (job.failedAt ?? null) !== null) {
      return;
    }
    // Issue #1237: 省略時は壁時計。⚠ `availableAt` の再計算はしない（interface の doc 参照）。
    // Issue #1108: 呼び手の `at` と同じ Date を保存しない。
    job.failedAt = opts?.at ? new Date(opts.at) : new Date();
    // Postgres の `text` は NUL（U+0000）を保存できない（22021）。`PostgresOutboxStore.fail` は
    // 目に見える6文字の `\u0000` へ置き換えて書く——同じ置換をする。
    job.lastError = error.replaceAll("\u0000", "\\u0000");
  }

  /**
   * Issue #1207 / ADR 0383: このテナントの `jobs`（完了・失敗・未処理を問わず）を、
   * `opts.limit` を目安に消す。`this.jobs` は `InMemoryMemoryStore` と共有される配列
   * （クラス冒頭の doc コメント参照）なので、`splice` でその場から取り除く
   * （新しい配列に差し替えると共有が壊れる）。
   *
   * `reachedLimit` は「削除した件数が `opts.limit` ちょうどだったか」だけで決める
   * （interface doc の「保守的な近似」）——ちょうど使い切った場合、実際にはもう
   * 残っていなくても `true` を返すことがある。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `limit` は `bigint` の引数へ渡される。整数でない・範囲外は Postgres が拒む。
    assertQueryBigint("eraseTenant", "limit", opts.limit);
    const matchingIndexes: number[] = [];
    for (let i = 0; i < this.jobs.length && matchingIndexes.length < opts.limit; i++) {
      if (this.jobs[i]!.tenantId === ctx.tenantId) {
        matchingIndexes.push(i);
      }
    }
    if (!opts.dryRun) {
      // 後ろから splice する——前から取り除くと、後続のインデックスがずれる。
      for (let i = matchingIndexes.length - 1; i >= 0; i--) {
        this.jobs.splice(matchingIndexes[i]!, 1);
      }
    }
    return { deleted: matchingIndexes.length, reachedLimit: matchingIndexes.length === opts.limit };
  }

  /**
   * [ADR 0404](../../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * `OutboxStore.purgeCompletedJobs?` の in-memory 実装（`PostgresOutboxStore` と同じ契約）。
   * `completedAt` が付いていて `< olderThan` の行だけを消す——claim 中・未処理・
   * `failedAt` の行は対象にならない。共有配列なので `splice` でその場から取り除く。
   */
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
