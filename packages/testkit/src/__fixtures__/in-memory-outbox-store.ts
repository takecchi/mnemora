import {
  OutboxLeaseConflictError,
  type ClaimOutboxJobsOptions,
  type Ctx,
  type OutboxJobRecord,
  type OutboxStore,
} from "@mnemora/core";

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
 * 例外も投げない（先に付いた終端が勝つ）。同種の再呼び出し（complete+complete、
 * fail+fail）の冪等な挙動は変えていない。
 */
export class InMemoryOutboxStore implements OutboxStore {
  constructor(private readonly jobs: OutboxJobRecord[]) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    // `PostgresOutboxStore` は `limit` を生 SQL の `LIMIT` にそのまま渡すため、負数を
    // 渡すと Postgres 自身が `LIMIT must not be negative` で例外を投げる（クエリを
    // 一切実行しない——claim の副作用も起きない）。ここで同じ入力を検査せずに
    // `eligible.slice(0, opts.limit)` へ渡すと、`Array.prototype.slice` の負数引数は
    // 「末尾から数えた除外」という別の意味になり、ジョブを黙って claim してしまう
    // （このクラスの doc が明言する「`PostgresOutboxStore` と一致させてある」という
    // 意図に反する）。クエリを投げる前に弾く Postgres 側に揃え、副作用が起きる前に
    // 例外を投げる。
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
      job.claimedAt = opts.now;
      job.claimedBy = opts.claimedBy;
      job.attempts += 1;
    }
    return claimed.map((job) => ({ ...job }));
  }

  async complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（fail）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    if ((job.failedAt ?? null) !== null) {
      return;
    }
    job.completedAt = new Date();
  }

  async fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（complete）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    if ((job.completedAt ?? null) !== null) {
      return;
    }
    job.failedAt = new Date();
    job.lastError = error;
  }
}
