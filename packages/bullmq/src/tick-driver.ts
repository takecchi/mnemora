import { Queue, Worker } from "bullmq";
import type { ConnectionOptions, Job } from "bullmq";
import type { Ctx, Runtime, TickOptions, TickResult } from "@mnemora/core";

/**
 * `@mnemora/bullmq` — BullMQ で `runtime.tick()` を駆動する役（Issue #205 の2本目、
 * ADR 0325 案B）。
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
 * この package はその relay を実装しない（採らなかった理由は ADR 0325 決定・
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
 * **`start()` を呼ぶまでジョブは処理しない**（Issue #890）。`createBullmqTickDriver(...)`
 * は Queue/Worker を構築するだけで、Worker は `autorun: false` で作る——ジョブの処理は
 * `start()` が明示的に `worker.run()` を呼んで初めて始まる。
 *
 * **`stop()` の後は再開できない**（Issue #891）。`stop()` を呼んだ driver は使い捨てである。
 * その後にもう一度 `start()` を呼ぶと Error を投げる——BullMQ の `Queue`/`Worker` は
 * `close()` した後、同じインスタンスを再利用できないため。もう一度動かしたいときは
 * `createBullmqTickDriver(...)` を新しく呼び直すこと。
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
 * `src/__tests__/concurrent-tick.redis.test.ts`（ADR 0325「測ったこと」）。
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
  /**
   * Worker を起動し、繰り返しジョブを登録する。**`start()` を呼ぶまでジョブは処理しない**
   * （Issue #890）。`stop()` の前に複数回呼んでも冪等（2回目以降は何もしない）。
   * **起動が途中で失敗して reject した後の `start()` は、登録と起動をやり直す**（Issue #963）
   * ——失敗した時点では Worker を走らせていない。同時に呼んだ `start()` は同じ起動を待つ。
   * ⛔ **`stop()` の後に呼ぶと Error を投げる**（Issue #891）——この driver は使い捨てであり、
   * 再開したい場合は `createBullmqTickDriver(...)` を呼び直すこと。
   */
  start(): Promise<void>;
  /**
   * 繰り返しジョブの登録を外し、Worker と Queue の接続を閉じる。**`start()` を一度も
   * 呼んでいなくても安全に呼べる。** 一度呼ぶと、この driver は使い捨てになる
   * （以後の `start()` は Error を投げる。Issue #891）。
   */
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
    // 🔴 Issue #890: 既定の `autorun: true`（bullmq 6.3.8、`Worker` コンストラクタ末尾
    // `if (this.opts.autorun) { this.run().catch(...) }`）のままだと、`start()` を
    // 一度も呼んでいない時点で Worker が Redis に繋ぎ、既にキューにあるジョブを
    // 処理し始めてしまう——上の doc コメント「使い方」の読み方と食い違う。
    // `autorun: false` で構築し、`start()` の中で明示的に `worker.run()` を呼ぶ。
    { connection: opts.connection, concurrency, autorun: false },
  );
  worker.on("error", (err) => {
    opts.onTickError?.(err);
  });

  // 起動中または起動済みの `start()` の promise。`null` は「まだ起動していない」（失敗した
  // 起動の後も含む）。同時に呼ばれた `start()` は同じ promise を待つ。
  let starting: Promise<void> | null = null;
  let stopped = false;

  return {
    async start() {
      // 🔴 Issue #891: `stop()` した driver の Queue/Worker は既に `close()` 済みであり、
      // bullmq はそれらを再利用できない（`node_modules/bullmq` の `queue-base.js`/
      // `worker.js` は `closing`/`closed` を一方向にしか進めない）。黙って何もせず
      // resolve すると「再開できた」ように見えてしまうため、理由の分かる Error で
      // 拒否する——再開したいなら `createBullmqTickDriver(...)` を呼び直すこと。
      if (stopped) {
        throw new Error(
          "createBullmqTickDriver: stop() 済みの driver で start() は呼べない（この driver は使い捨てである）。" +
            " 再開したい場合は createBullmqTickDriver(...) を呼び直すこと。",
        );
      }
      if (starting !== null) {
        return starting;
      }
      // 🔴 Issue #963: 起動が途中で失敗したら「起動済み」の印を残さない——失敗した
      // `start()` の後の `start()` が何もせず resolve すると、Worker は動くのに
      // スケジュールが無く、tick が一度も発火しないまま「起動できた」ように見える。
      // そのために、失敗しうる登録（`upsertJobScheduler`）を**先に**済ませ、Worker は
      // 登録が成功した後でだけ走らせる。bullmq の Worker は一度 `run()` / `close()` すると
      // 再利用できない（Issue #891）ので、失敗しうる手順の前に走らせてしまうと片付け
      // ようがない。登録が失敗した時点では Worker はまだ走っておらず、片付けるものは無い。
      const attempt = (async () => {
        // BullMQ 6.x の Job Scheduler API（旧 `queue.add(..., { repeat })` /
        // `queue.removeRepeatable(...)` は 6.x の型に無い——`upsertJobScheduler` に
        // 置き換わった。`jobSchedulerId` を固定値にすることで、複数プロセスが同じ
        // `queueName` に対して `start()` を呼んでも冪等に同じスケジュールを指す
        // （上の doc コメント「複数プロセスで動かすとき」参照）。
        await queue.upsertJobScheduler(jobName, { every: opts.everyMs }, { name: jobName });
        // 登録を待つ間に `stop()` された場合は、閉じた Worker を走らせない。
        if (stopped) {
          return;
        }
        // Worker は上で `autorun: false` で構築したので、ここで明示的に起動する。
        // ⚠ `worker.run()` が返す promise は、Worker が閉じるまで resolve しない
        // （bullmq 6.3.8 の `mainLoop` は `while ((!this.closing && !this.paused) || ...)`
        // というループであり、`this.closing` が立つのは `worker.close()` を呼んだ後）。
        // ここで `await` すると `start()` 自体が `stop()` されるまで返らなくなるため、
        // 意図的に await しない。reject は握りつぶさず、bullmq 自身が `autorun: true` の
        // ときに内部で行っている `this.run().catch(error => this.emit('error', error))`
        // と同じ形で `worker` の `"error"` listener（上で登録済み、`onTickError` へ流す）
        // に載せる。
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
      // `start()` を一度も呼んでいなくても安全に呼べる——`worker.close()` は
      // `run()`/`mainLoop()` が動いていることに依存しない（`whenCurrentJobsFinished`/
      // `lockManager.close`/`childPool.clean`/`backend.close` の順で、動いていなければ
      // 素通りする。bullmq 6.3.8 の `worker.js` を読んで確認済み）。
      stopped = true;
      try {
        await queue.removeJobScheduler(jobName);
      } finally {
        // `worker.close()` と `queue.close()` はそれぞれ独立した資源（Worker 自身の
        // blocking connection と Queue の connection）を閉じる。どちらも await せず
        // 同じ finally に並べて書くと、`worker.close()` が reject したとき
        // `queue.close()` の行に到達せず、Queue 側の接続が開いたまま残る
        // （`tick-driver.stop-cleanup.test.ts` が実測）。内側にもう一段 try/finally を
        // 挟み、`worker.close()` が失敗しても `queue.close()` は必ず試みる。
        try {
          await worker.close();
        } finally {
          await queue.close();
        }
      }
    },
  };
}
