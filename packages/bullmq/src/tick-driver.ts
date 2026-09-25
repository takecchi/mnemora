import { Queue, Worker } from "bullmq";
import type { ConnectionOptions, Job } from "bullmq";
import type { Ctx, Runtime, TickOptions, TickResult } from "@mnemora/core";

/**
 * `@mnemora/bullmq` — BullMQ で `runtime.tick()` を駆動する役（Issue #205 の2本目、
 * ADR 0321〔仮番号。マージ時に `adr-renumber.mjs` が確定する〕案B）。
 *
 * 🔴 **この package は `@mnemora/core` の `Scheduler` interface を実装しない。**
 * `Scheduler.enqueue`（`packages/core/src/interfaces/scheduler.ts`）は本番コードの
 * どこからも呼ばれておらず（2026-09-25 時点の調査）、実装しても呼び手が無い。
 * ここが実装するのは「BullMQ の Worker が定期的に発火し、その都度 `runtime.tick()` を
 * 呼ぶ」という、それだけの役である。
 *
 * **outbox は今日どおり Postgres が正本のまま。**BullMQ（Redis）はジョブの中身を
 * 一切持たない——運ぶのは「いま tick して」という合図だけであり、outbox の行と
 * Redis 側のジョブが二重に帳簿を持つことはない。`docs/decisions/0005-job-queue-abstraction.md`
 * が書いた「実際のキューへは relay が outbox の未処理行を読んで渡す」という設計
 * （outbox → BullMQ へジョブそのものを運ぶ案）とは**別の形**であることに注意——
 * この package はその relay を実装しない（採らなかった理由は ADR 0321 決定・
 * 「採らなかった案」を見ること）。
 *
 * ## 使い方
 *
 * ```ts
 * const driver = createBullmqTickDriver({
 *   connection: { host: "127.0.0.1", port: 6379 },
 *   queueName: "mnemora-tick",
 *   runtime,
 *   ctx: { tenantId: "acme" },
 *   tick: { leaseMs: 30 * 60 * 1000, kinds: ["embed"] },
 *   everyMs: 5_000,
 * });
 * await driver.start();
 * // ... プロセスが生きている間、5秒おきに runtime.tick() が呼ばれる ...
 * await driver.stop();
 * ```
 *
 * ## 複数プロセスで動かすとき
 *
 * **同じ `queueName` に対して複数プロセスが `createBullmqTickDriver(...).start()` を
 * 呼んでよい。**`start()` は BullMQ 6.x の Job Scheduler（`queue.upsertJobScheduler`）を
 * `jobSchedulerId` 固定値（既定は `jobName`）で登録するため、二重登録にはならない
 * ——後から呼んだ側は同じスケジュールを再登録するだけである。**発火した個々の
 * tick ジョブは、その時点で空いているどのプロセスの Worker が処理してもよい**
 * （BullMQ の通常の負荷分散）。
 *
 * 🔴 **これは「同じテナントに対して2つの `runtime.tick()` が同時に走らない」ことを
 * 保証しない。**むしろ逆——処理に `everyMs` より長くかかると、BullMQ は次の発火分を
 * 別の Worker（別プロセスでも可）に渡しうる。**この重なりから outbox の二重処理を
 * 防いでいるのは `packages/postgres` の `PostgresOutboxStore.claimBatch`
 * （`FOR UPDATE SKIP LOCKED`、ADR 0206）であって、この package や BullMQ 自身では
 * ない。**その主張を複数 OS プロセス・複数 `pg.Pool` に対して実測したのが
 * `src/__tests__/concurrent-tick.redis.test.ts`（ADR 0321「測ったこと」）。
 */
export interface CreateBullmqTickDriverOptions {
  /** BullMQ の Redis 接続先。`bullmq` 自身の `ConnectionOptions`（ioredis 互換）をそのまま使う。 */
  connection: ConnectionOptions;
  /** BullMQ の queue 名。同じ queue を複数プロセスで共有してよい（上の doc 参照）。 */
  queueName: string;
  /** `tick()` を持つだけの最小限の Runtime（テストでは `Pick<Runtime, "tick">` で足りる）。 */
  runtime: Pick<Runtime, "tick">;
  ctx: Ctx;
  /** `runtime.tick(ctx, tick)` へそのまま渡す。`leaseMs` は必須（`TickOptions` 自身の契約）。 */
  tick: TickOptions;
  /** 発火間隔（ミリ秒）。BullMQ の `repeat.every` にそのまま渡す。 */
  everyMs: number;
  /**
   * この Worker が同時に処理する tick ジョブの最大数。既定 `1`。
   * 複数プロセス・複数 Worker が同じ queue に付くと、プロセスをまたいだ同時実行も
   * 起こりうる（上の doc 参照）——`concurrency` はあくまで「このプロセス内」の上限。
   */
  concurrency?: number;
  /** 繰り返しジョブの名前・`jobId`。既定 `"mnemora-tick"`。 */
  jobName?: string;
  /** `runtime.tick()` が返るたびに呼ばれる（観測用。省略可）。 */
  onTickResult?: (result: TickResult) => void;
  /** Worker が `"error"` を emit したときに呼ばれる（観測用。省略可）。 */
  onTickError?: (error: unknown) => void;
}

export interface BullmqTickDriver {
  /** 繰り返しジョブを登録する（冪等）。 */
  start(): Promise<void>;
  /** 繰り返しジョブの登録を外し、Worker と Queue の接続を閉じる。 */
  stop(): Promise<void>;
}

const DEFAULT_JOB_NAME = "mnemora-tick";

/**
 * `concurrency` の入力を検証して既定値を補う純関数（Redis 接続を持たない——
 * `test`（Redis 不要）で検査できるのはこの関数だけである。BullMQ の `Queue`/`Worker`
 * を実際に構築する検査は `test:redis` 側に置く、AGENTS.md 「手元で Postgres を立てる」
 * 節と同じ「本物でしか測れないものは本物でしか測らない」判断）。
 */
export function resolveConcurrency(concurrency?: number): number {
  if (concurrency === undefined) {
    return 1;
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `createBullmqTickDriver: concurrency must be a positive integer, got ${String(concurrency)}`,
    );
  }
  return concurrency;
}

export function createBullmqTickDriver(opts: CreateBullmqTickDriverOptions): BullmqTickDriver {
  const jobName = opts.jobName ?? DEFAULT_JOB_NAME;
  const concurrency = resolveConcurrency(opts.concurrency);

  const queue = new Queue(opts.queueName, { connection: opts.connection });
  const worker = new Worker(
    opts.queueName,
    async (_job: Job) => {
      const result = await opts.runtime.tick(opts.ctx, opts.tick);
      opts.onTickResult?.(result);
      return result;
    },
    { connection: opts.connection, concurrency },
  );
  worker.on("error", (err) => {
    opts.onTickError?.(err);
  });

  let started = false;

  return {
    async start() {
      if (started) {
        return;
      }
      started = true;
      // BullMQ 6.x の Job Scheduler API（旧 `queue.add(..., { repeat })` /
      // `queue.removeRepeatable(...)` は 6.x の型に無い——`upsertJobScheduler` に
      // 置き換わった。`jobSchedulerId` を固定値にすることで、複数プロセスが同じ
      // `queueName` に対して `start()` を呼んでも冪等に同じスケジュールを指す
      // （上の doc コメント「複数プロセスで動かすとき」参照）。
      await queue.upsertJobScheduler(jobName, { every: opts.everyMs }, { name: jobName });
    },
    async stop() {
      try {
        await queue.removeJobScheduler(jobName);
      } finally {
        await worker.close();
        await queue.close();
      }
    },
  };
}
