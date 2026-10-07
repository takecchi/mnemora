import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type { ConnectionOptions, Job } from "bullmq";
import type { Ctx, Runtime, TickOptions, TickResult } from "@mnemora/core";

/**
 * BullMQ の Worker が定期的に発火し、その都度 `runtime.tick()` を呼ぶ driver の設定。
 * `@mnemora/core` の `Scheduler` は実装しない。outbox の正本は Postgres のままで、Redis が運ぶのは「tick して」という合図だけ。
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
 * await driver.stop();
 * ```
 *
 * - `start()` を呼ぶまでジョブは処理しない。`stop()` の後は再開できず、`start()` は Error を投げる。
 * - tick の失敗（`runtime.tick()` の throw）と Worker・Queue の異常は `onTickError` に、成功した tick の結果は `onTickResult` に届く。
 *   tick の中の個々のジョブ（outbox の行）の失敗は `onTickError` に届かない。`onTickResult` の `TickResult.failed`・`unsupported` と outbox の `last_error` 列で見る。
 * - 同じ `queueName` に複数プロセスが `start()` してよい（scheduler は固定 id で登録され、二重にならない）。
 *   同じテナントの `runtime.tick()` が同時に走らないことは保証しない。二重処理を防ぐのは `PostgresOutboxStore.claimBatch` である。
 * - `queueName` か `jobName` はテナント（`ctx`）ごとに分ける。同じなら scheduler は1つに上書きされ、1回の発火はどれか1つのテナントの tick にしかならない。
 * - `stop()` は、同じ `queueName` に自分以外の Worker が居るときは共有の scheduler を消さない。詳細は {@link BullmqTickDriver.stop}。
 * - 完了したジョブは直近 1000 件だけ残る（`completedJobsToKeep`）。失敗したジョブは `removeOnFail` を指定しないので全部残る。
 */
export interface CreateBullmqTickDriverOptions {
  /**
   * BullMQ の Redis 接続先（`ConnectionOptions`）。ioredis のインスタンスを渡すなら `maxRetriesPerRequest: null` が要り、
   * 無いと `createBullmqTickDriver` が同期的に throw する。インスタンスは `stop()` の後も閉じられない。
   */
  connection: ConnectionOptions;
  /**
   * BullMQ の queue 名。driver は検査せず BullMQ に渡すので、空文字と `:` を含む名前は `createBullmqTickDriver` が同期的に投げる。
   */
  queueName: string;
  /** `tick()` だけを持つ最小限の Runtime。 */
  runtime: Pick<Runtime, "tick">;
  ctx: Ctx;
  /** `runtime.tick(ctx, tick)` へそのまま渡す。 */
  tick: TickOptions;
  /**
   * 発火間隔（ミリ秒）。BullMQ の `repeat.every` にそのまま渡す。
   * 数・有限・`1` 以上・`Number.MAX_SAFE_INTEGER` 以下でなければ構築時に投げる（数でなければ `TypeError`、数として不正なら `RangeError`）。
   * 小数は通す。
   */
  everyMs: number;
  /**
   * この Worker が同時に処理する tick ジョブの最大数（このプロセス内の上限）。既定 `1`。
   * 正の整数でなければ構築時に投げる（数でなければ `TypeError`、小数・`NaN`・`1` 未満なら `RangeError`）。
   */
  concurrency?: number | undefined;
  /**
   * Worker が処理中のジョブの lock の期限（ミリ秒）。BullMQ の `WorkerOptions.lockDuration` にそのまま渡す。
   * 省略時は BullMQ の既定（30000 ms）。1 回の tick がそれより長くかかるなら長くする。
   * 正の整数（`Number.MAX_SAFE_INTEGER` 以下）でなければ構築時に投げる（数でなければ `TypeError`、数として不正なら `RangeError`）。
   */
  lockDuration?: number | undefined;
  /**
   * 完了したジョブを Redis に残す件数（新しい順）。既定 `1000`。`removeOnFail` は変えない（失敗したジョブは全部残る）。
   * `0` 以上の整数でなければ構築時に投げる（数でなければ `TypeError`、数として不正なら `RangeError`）。
   */
  completedJobsToKeep?: number | undefined;
  /**
   * 繰り返しジョブの名前・`jobId`。既定 `"mnemora-tick"`。
   * 渡すなら空でない文字列でなければ構築時に投げる（文字列でなければ `TypeError`、空文字なら `RangeError`）。
   */
  jobName?: string | undefined;
  /**
   * `runtime.tick()` が返るたびに呼ばれる（観測用）。個々のジョブの失敗は throw ではなく
   * `result.failed`・`result.unsupported` に載る。失敗した行の理由は outbox の `last_error` 列にある。
   */
  onTickResult?: ((result: TickResult) => void) | undefined;
  /**
   * tick の失敗と、Worker・Queue の異常を受け取る（観測用）。`runtime.tick()`（と `onTickResult`）の throw、
   * Worker の `'error'`、Queue の `'error'` の3経路から、`error` を渡して呼ばれる。
   *
   * 渡さないとき、Queue の異常は bullmq の既定どおり `console.error` に出る（listener を付けると既定の出力が消えるため付けない）。
   * Worker の異常は黙る。Queue と Worker は別の Redis 接続を持つので、同じ障害について複数回呼ばれうる（束ねない）。
   * lock の期限切れ（stalled）では、`onTickResult` の後に `onTickError` が届くことがある（`Missing lock ... moveToFinished`）。
   */
  onTickError?: ((error: unknown) => void) | undefined;
}

export interface BullmqTickDriver {
  /**
   * Worker を起動し、繰り返しジョブを登録する。`stop()` の前に複数回呼んでも冪等で、同時に呼んだ `start()` は同じ起動を待つ。
   * 起動が失敗して reject した後の `start()` は、登録と起動をやり直す。
   * Redis に繋がらない間は reject せず pending のまま待ち続ける（その間 `onTickError` に届く）。
   * 登録は `start()` の1回だけで、永続化なしの Redis の再起動で scheduler が消えても自動では戻らない。
   * `stop()` の後に呼ぶと Error を投げる（driver は使い捨て）。
   */
  start(): Promise<void>;
  /**
   * 繰り返しジョブの登録を（最後の Worker のときだけ）外し、Worker と Queue の接続を閉じる。`start()` を呼んでいなくても安全に呼べる。
   * 一度呼ぶと使い捨てになる。
   *
   * 同じ queue に自分以外の Worker が居る（`queue.getWorkers()` で見る）ときは scheduler を外さない。
   * `getWorkers()` が使えない・判別できない環境（`CLIENT LIST` を禁じた ACL など）では外し、残りのプロセスの tick が止まる。
   * 2台が同時に `stop()` すると、どちらも外さず scheduler が1件残りうる。
   */
  stop(): Promise<void>;
}

const DEFAULT_JOB_NAME = "mnemora-tick";
const DEFAULT_COMPLETED_JOBS_TO_KEEP = 1000;

/** `concurrency` を検証して既定値（`1`）を補う。正の整数でなければ `TypeError` / `RangeError` を投げる。 */
export function resolveConcurrency(concurrency?: number): number {
  if (concurrency === undefined) {
    return 1;
  }
  const message = `createBullmqTickDriver: concurrency must be a positive integer, got ${String(concurrency)}`;
  if (typeof concurrency !== "number") {
    throw new TypeError(message);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(message);
  }
  return concurrency;
}

function assertEveryMs(everyMs: unknown): asserts everyMs is number {
  const message = `createBullmqTickDriver: everyMs must be a finite number between 1 and Number.MAX_SAFE_INTEGER (milliseconds), got ${String(everyMs)}`;
  if (typeof everyMs !== "number") {
    throw new TypeError(message);
  }
  if (!Number.isFinite(everyMs) || everyMs < 1 || everyMs > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(message);
  }
}

function resolveJobName(jobName: unknown): string {
  if (jobName === undefined) {
    return DEFAULT_JOB_NAME;
  }
  const message = `createBullmqTickDriver: jobName must be a non-empty string when given, got ${String(jobName)}`;
  if (typeof jobName !== "string") {
    throw new TypeError(message);
  }
  if (jobName.length === 0) {
    throw new RangeError(message);
  }
  return jobName;
}

function resolveLockDuration(lockDuration: unknown): number | undefined {
  if (lockDuration === undefined) {
    return undefined;
  }
  const message = `createBullmqTickDriver: lockDuration must be a positive integer (milliseconds), got ${String(lockDuration)}`;
  if (typeof lockDuration !== "number") {
    throw new TypeError(message);
  }
  if (
    !Number.isInteger(lockDuration) ||
    lockDuration < 1 ||
    lockDuration > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(message);
  }
  return lockDuration;
}

function resolveCompletedJobsToKeep(completedJobsToKeep: unknown): number {
  if (completedJobsToKeep === undefined) {
    return DEFAULT_COMPLETED_JOBS_TO_KEEP;
  }
  const message = `createBullmqTickDriver: completedJobsToKeep must be a non-negative integer, got ${String(completedJobsToKeep)}`;
  if (typeof completedJobsToKeep !== "number") {
    throw new TypeError(message);
  }
  if (
    !Number.isInteger(completedJobsToKeep) ||
    completedJobsToKeep < 0 ||
    completedJobsToKeep > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(message);
  }
  return completedJobsToKeep;
}

export function createBullmqTickDriver(opts: CreateBullmqTickDriverOptions): BullmqTickDriver {
  assertEveryMs(opts.everyMs);
  const jobName = resolveJobName(opts.jobName);
  const concurrency = resolveConcurrency(opts.concurrency);
  const lockDuration = resolveLockDuration(opts.lockDuration);
  const completedJobsToKeep = resolveCompletedJobsToKeep(opts.completedJobsToKeep);

  const queue = new Queue(opts.queueName, { connection: opts.connection });
  // `onTickError` があるときだけ listener を付ける: 付けると bullmq の既定の `console.error` が消え、Queue の異常が黙る。
  const onQueueError = opts.onTickError;
  if (onQueueError) {
    queue.on("error", (err) => {
      onQueueError(err);
    });
  }
  const workerName = `mnemora-tick-${randomUUID()}`;
  const selfSuffix = `:w:${workerName}`;
  const worker = new Worker(
    opts.queueName,
    async (_job: Job) => {
      const result = await opts.runtime.tick(opts.ctx, opts.tick);
      opts.onTickResult?.(result);
      return result;
    },
    // `autorun: false`: 既定の `true` だと `start()` の前から Worker が処理し始める。
    {
      connection: opts.connection,
      concurrency,
      name: workerName,
      autorun: false,
      ...(lockDuration === undefined ? {} : { lockDuration }),
    },
  );
  worker.on("error", (err) => {
    opts.onTickError?.(err);
  });
  // processor の throw は `'error'` ではなく `'failed'` で来る。拾わないと tick の失敗を取りこぼす。
  worker.on("failed", (_job, err) => {
    opts.onTickError?.(err);
  });

  let starting: Promise<void> | null = null;
  let stopped = false;

  // 居るかどうか分からないときは「居ない」に倒す（今までどおり消す）:
  // `getWorkers()` が throw したとき。行に `rawname` が無いとき（bullmq は CLIENT 未対応の環境で偽の1件を返し、
  // これを「他が居る」と読むと scheduler が誰にも消されず残る）。
  // 自分は `:w:<workerName>` で終わる接続名で見分け、名前なしの Worker や他の driver の Worker は「他」と数える。
  async function hasOtherWorkers(): Promise<boolean> {
    try {
      const workers = await queue.getWorkers();
      if (workers.some((w) => typeof w["rawname"] !== "string")) {
        return false;
      }
      return workers.some((w) => !(w["rawname"] as string).endsWith(selfSuffix));
    } catch {
      return false;
    }
  }

  return {
    async start() {
      if (stopped) {
        throw new Error(
          "createBullmqTickDriver: stop() 済みの driver で start() は呼べない（この driver は使い捨てである）。" +
            " 再開したい場合は createBullmqTickDriver(...) を呼び直すこと。",
        );
      }
      if (starting !== null) {
        return starting;
      }
      // 失敗しうる登録（`upsertJobScheduler`）を先に済ませ、Worker は登録の成功後にだけ走らせる:
      // Worker は一度 `run()` / `close()` すると再利用できず、先に走らせると片付けようがない。
      const attempt = (async () => {
        await queue.upsertJobScheduler(
          jobName,
          { every: opts.everyMs },
          { name: jobName, opts: { removeOnComplete: { count: completedJobsToKeep } } },
        );
        if (stopped) {
          return;
        }
        // `worker.run()` は await しない: Worker が閉じるまで resolve しないので、`start()` が `stop()` まで返らなくなる。
        worker.run().catch((error) => worker.emit("error", error));
      })();
      starting = attempt;
      attempt.catch(() => {
        if (starting === attempt) {
          starting = null;
        }
      });
      return attempt;
    },
    async stop() {
      stopped = true;
      try {
        if (!(await hasOtherWorkers())) {
          await queue.removeJobScheduler(jobName);
        }
      } finally {
        // 並べて書かない: `worker.close()` が reject しても `queue.close()` を必ず試みる（さもないと Queue の接続が開いたまま残る）。
        try {
          await worker.close();
        } finally {
          await queue.close();
        }
      }
    },
  };
}
