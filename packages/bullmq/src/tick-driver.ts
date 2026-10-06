import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type { ConnectionOptions, Job } from "bullmq";
import type { Ctx, Runtime, TickOptions, TickResult } from "@mnemora/core";

/**
 * `@mnemora/bullmq` — BullMQ で `runtime.tick()` を駆動する役（Issue #205 の2本目、
 * ADR 0325 案B）。
 *
 * 🔴 **この package は `@mnemora/core` の `Scheduler` interface を実装しない。**
 * `Scheduler.enqueue`（`packages/core/src/interfaces/scheduler.ts`）は本番コードの
 * どこからも呼ばれておらず、実装しても呼び手が無い。
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
 * tick の失敗（`runtime.tick()` の throw）と、Worker・Queue の異常（接続の失敗など）は、`onTickError` に
 * 届く。成功した tick の結果は `onTickResult` に届く（どちらも省略可）。詳しくは `CreateBullmqTickDriverOptions` の各 doc。
 *
 * ⚠ **`onTickError` は、tick の中の個々のジョブ（outbox の行）の失敗を知らせない。** tick が throw しなければ鳴らない。
 * 個々のジョブの失敗は、`onTickResult` の `TickResult.failed`・`unsupported` と、outbox の `last_error` 列で見る。
 *
 * **`start()` を呼ぶまでジョブは処理しない**（Issue #890）。`createBullmqTickDriver(...)`
 * は Queue/Worker を構築するだけで、Worker は `autorun: false` で作る。
 *
 * **`stop()` の後は再開できない**（Issue #891）。`stop()` した driver は使い捨てで、その後の
 * `start()` は Error を投げる（BullMQ の `Queue`/`Worker` は `close()` 後に再利用できない）。
 * 動かし直すときは `createBullmqTickDriver(...)` を呼び直すこと。
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
 *
 * 🔴 **`stop()` は、同じ `queueName` に自分以外の Worker が居るときは共有の scheduler を消さない。最後の1台だけが消す**
 * （ADR 0655。【実測】redis-server 7.4.7・bullmq 6.3.8）。`queue.getWorkers()`（`CLIENT LIST`）が使えない環境では
 * 判別できず消す。例外と残る穴は {@link BullmqTickDriver.stop} の doc 参照。
 *
 * 🔴 **`queueName` か `jobName` は、テナント（`ctx`）ごとに分けること**（【実測】redis-server 7.4.7・bullmq 6.3.8、ADR 0449。後から `start()` した driver の `everyMs` で scheduler が置き換わり、先に動いていた driver の間隔も変わる）。
 * Worker はジョブの中身を見ずに、自分の `ctx` で `runtime.tick()` を呼ぶ。テナントの違う driver が同じ
 * `queueName` と同じ `jobName`（既定 `"mnemora-tick"`）を使うと、scheduler は1つに上書きされ（`everyMs` は最後に
 * `start()` した driver の値）、1回の発火はどれか1つのテナントの tick にしかならない。
 *
 * ## 完了したジョブは直近 1000 件だけ残る（失敗したジョブは全部残る）
 *
 * ADR 0548: この driver は繰り返しジョブの template（`upsertJobScheduler` の第3引数）に `removeOnComplete: { count: 1000 }`
 * を既定で入れる。完了したジョブは新しい順に 1000 件だけ Redis に残り、それより古いものは BullMQ が消す
 * （`completedJobsToKeep` で件数を変えられる）。
 * **`removeOnFail` は指定していない。** BullMQ 6.3.8 は指定が無いと失敗したジョブを全部残す
 * （`redis-queue-backend.js` の `getKeepJobs` が `{ count: -1 }` を返す）。失敗は調べる材料なので残し、消す口は足していない。
 * 溜まるのが気になるなら、同じ `queueName` の `Queue` を自分で作り、`queue.clean(grace, limit, "failed")` を定期的に呼ぶ
 * （README「完了したジョブは直近 1000 件だけ残る」）。
 */
export interface CreateBullmqTickDriverOptions {
  /**
   * BullMQ の Redis 接続先。`bullmq` 自身の `ConnectionOptions`（ioredis 互換）をそのまま使う。
   * ⚠ ioredis のインスタンスを渡すなら `maxRetriesPerRequest: null` が要る。無いと `createBullmqTickDriver` が同期的に
   * throw する（【実測】bullmq 6.3.8、ADR 0449）。インスタンスは `stop()` の後も閉じられない（呼び出し側が閉じる）。
   */
  connection: ConnectionOptions;
  /**
   * BullMQ の queue 名。同じ queue を複数プロセスで共有してよい（上の doc 参照）。
   *
   * ⚠ ADR 0477: **driver はこの値を検査せず BullMQ に渡す。** 空文字と `:` を含む名前は、BullMQ が
   * `createBullmqTickDriver(...)` の中で同期的に投げる（`Queue name must be provided`・`Queue name cannot contain :`。
   * 投げる前に Redis へは繋がない）。空白だけ・日本語・300 文字の名前は動く（【実測】redis-server 7.4.7・bullmq 6.3.8）。
   */
  queueName: string;
  /** `tick()` を持つだけの最小限の Runtime（テストでは `Pick<Runtime, "tick">` で足りる）。 */
  runtime: Pick<Runtime, "tick">;
  ctx: Ctx;
  /** `runtime.tick(ctx, tick)` へそのまま渡す。`leaseMs` は必須（`TickOptions` 自身の契約）。 */
  tick: TickOptions;
  /**
   * 発火間隔（ミリ秒）。BullMQ の `repeat.every` にそのまま渡す。
   *
   * ⚠ ADR 0498: **構築時に検査し、数・有限・`1` 以上・`Number.MAX_SAFE_INTEGER` 以下でなければ
   * `createBullmqTickDriver(...)` が投げる**（ADR 0525: 数でなければ `TypeError`、数として不正なら `RangeError`）（`Queue`・`Worker` は作らない）。小数（`1.5`）は通る（BullMQ が
   * 切り捨てた間隔で動く）。数値の文字列（`"50"`）は断る。【実測】（ADR 0477。redis-server 7.4.7・
   * bullmq 6.3.8）負の値・`1` 未満の小数・`1e21` では `start()` が成功したまま tick が数回で黙って止まる
   * （`onTickError` にも届かない）ため、構築時に断る。
   */
  everyMs: number;
  /**
   * この Worker が同時に処理する tick ジョブの最大数。既定 `1`。
   * 複数プロセス・複数 Worker が同じ queue に付くと、プロセスをまたいだ同時実行も
   * 起こりうる（上の doc 参照）——`concurrency` はあくまで「このプロセス内」の上限。
   *
   * 正の整数でなければ構築時に投げる（ADR 0525: 数でなければ `TypeError`、小数・`NaN`・`1` 未満なら `RangeError`）。
   */
  concurrency?: number | undefined;
  /**
   * Worker が処理中のジョブの lock の期限（ミリ秒）。BullMQ の `WorkerOptions.lockDuration` にそのまま渡す。
   * 省略（`undefined`）なら Worker に渡さず、BullMQ の既定（30000 ms。bullmq 6.3.8）になる。
   *
   * ADR 0548: **正の整数（`1` 以上、`Number.MAX_SAFE_INTEGER` 以下）でなければ構築時に投げる**（ADR 0525: 数でなければ `TypeError`、
   * 小数・`NaN`・`Infinity`・`1` 未満・上限超なら `RangeError`。`Queue`・`Worker` は作らない）。
   * `runtime.tick()` がイベントループを長く塞ぐ、または 1 回の tick が 30 秒より長くかかる環境で、lock の期限切れ
   * （stalled）による同じ tick の再実行を減らすために長くする。BullMQ は lock をこの値の半分の間隔で延ばす。
   * 長くしすぎると、プロセスが落ちたときに別の Worker が引き継ぐまでの時間が伸びる。
   * ⚠ 上限（`Number.MAX_SAFE_INTEGER`）を超える値を断るのは `everyMs` に合わせた安全側の線で、Redis に渡して測った境目ではない。
   */
  lockDuration?: number | undefined;
  /**
   * 完了したジョブを Redis に残す件数（新しい順）。既定 `1000`。BullMQ の `removeOnComplete: { count }` として、
   * 繰り返しジョブの template に入る（ADR 0548）。
   *
   * `0` 以上の整数でなければ構築時に投げる（ADR 0525: 数でなければ `TypeError`、小数・`NaN`・`Infinity`・負・
   * `Number.MAX_SAFE_INTEGER` 超なら `RangeError`）。`0` は完了したらすぐ消す。ほぼ全部残すなら
   * `Number.MAX_SAFE_INTEGER` を渡す。失敗したジョブ（`removeOnFail`）は、この欄では変わらない（全部残る）。
   */
  completedJobsToKeep?: number | undefined;
  /**
   * 繰り返しジョブの名前・`jobId`。既定 `"mnemora-tick"`。
   *
   * ⚠ ADR 0498: **省略（`undefined`）なら既定。渡すなら空でない文字列でなければ、構築時に投げる。**（ADR 0525: 文字列でなければ `TypeError`、空文字なら `RangeError`） 空文字は
   * 【実測】（ADR 0477）`start()` が成功したまま tick が1回で黙って止まる。`:` を含む名前・空白・日本語・300 文字は動くので断らない。
   */
  jobName?: string | undefined;
  /**
   * `runtime.tick()` が返るたびに呼ばれる（観測用。省略可）。
   *
   * ⚠ **tick の中の個々のジョブ（outbox の行）の失敗は、`onTickError` ではなくここに届く。** 個々のジョブが失敗しても
   * `runtime.tick()` は throw せず `TickResult` を返すので、`result.failed`（`fail()` を呼んでリース競合で弾かれなかった
   * 件数。⚠ 終端 `failed` になった行の数と常に一致するとは限らない）と `result.unsupported`（`failed` の内訳のうち、`tick` が
   * その kind を処理できなかったもの）を見ること。失敗した行の理由は outbox の `last_error` 列にある。
   */
  onTickResult?: ((result: TickResult) => void) | undefined;
  /**
   * tick の失敗と、Worker・Queue の異常を受け取る（観測用。省略可）。次の3つの経路から、`error` を渡して呼ばれる。
   *
   * 🔴 **届くのはこの3つだけである。** tick の中の個々のジョブ（outbox の行）が失敗しても、`runtime.tick()` が throw
   * しなければ `onTickError` は鳴らない（その失敗は `onTickResult` に渡る `TickResult` の `failed`・`unsupported` と、
   * outbox の `last_error` 列で見る）。`onTickError` を渡しただけでは、ジョブ単位の失敗は分からない。
   *
   * - **`runtime.tick()`（と `onTickResult`）が throw した** ——BullMQ の Worker は processor の throw を
   *   `'error'` ではなく `'failed'`（job, err）として emit する（bullmq 6.3.8 の実測）ので、driver は
   *   `'failed'` を拾って **job ではなく error だけ**を渡す。失敗した tick のジョブは BullMQ 側に failed として残るが、繰り返しジョブは
   *   次の発火でまた tick する（この driver は再試行を足していない）。
   * - Worker が `'error'` を emit した（Redis 接続の異常、`worker.run()` の reject など）。
   *
   * - Queue が `'error'` を emit した（繰り返しジョブの登録に使う Queue の Redis 接続の異常など）。
   *
   * 🔴 **`onTickError` を渡さないとき、Queue には listener を付けない。** 付けると bullmq（6.3.8 の
   * `QueueBase.emit`。listener の無い `'error'` は EventEmitter が throw し、それを捕まえて `console.error`
   * へ出す）の既定の出力が消え、Queue の異常が完全に黙る。渡していなければ `console.error` に出る。
   * （Worker は常に listener を付けており、`onTickError` が無ければ Worker の異常は黙る。）
   *
   * **1回の tick の失敗は `'failed'` の1回だけ**（BullMQ は processor の throw で `'error'` を併せて emit しない）。
   * 一方、Queue と Worker は別々の Redis 接続を持ち、接続ごとに `'error'` を emit する。Redis が落ちると
   * **両方の接続**が error を出すので、`onTickError` は同じ障害について複数回（Queue 由来と Worker 由来。再接続の
   * たびにも）呼ばれうる。同じ事象の重複ではなく別の接続の事象であり、driver は束ねない（束ねると片方だけが
   * 壊れたときに見えなくなる）。【実測】Redis が居ないポートを指すと、Queue と Worker がそれぞれ
   * ECONNREFUSED を emit した（bullmq 6.3.8）。
   *
   * ⚠ **lock の期限切れ（stalled）で、1回の tick に `onTickResult` の後で `onTickError` が届く**
   * 【実測】redis-server 7.4.7・bullmq 6.3.8（ADR 0449）: 2つの OS プロセスの一方の `tick()` がイベントループを45秒塞ぐと、もう一方の Worker が約60秒後に
   * 2本目の tick を走らせ、塞いでいた1本目は `onTickResult` の後に `onTickError` を0.1秒以内に2回（`Missing lock ... moveToFinished`）鳴らした。
   * lock（`lockDuration`、bullmq の既定 30000 ms。ADR 0548 以降は `CreateBullmqTickDriverOptions.lockDuration` で変えられる）が切れると、stalled checker が
   * ジョブを戻して別の Worker が2本目の tick を走らせる。outbox の CAS でジョブは二重に処理されず、データは壊れない。
   * 遅れて終わった1本目は `onTickResult` を呼んだ後、`moveToCompleted` が `Missing lock` で失敗し、`error` 経由で
   * `onTickError` に届く。詳しくは README の「lock の期限切れ（stalled）」。
   */
  onTickError?: ((error: unknown) => void) | undefined;
}

export interface BullmqTickDriver {
  /**
   * Worker を起動し、繰り返しジョブを登録する。**`start()` を呼ぶまでジョブは処理しない**
   * （Issue #890）。`stop()` の前に複数回呼んでも冪等（2回目以降は何もしない）。
   * **起動が途中で失敗して reject した後の `start()` は、登録と起動をやり直す**（Issue #963）
   * ——失敗した時点では Worker を走らせていない。同時に呼んだ `start()` は同じ起動を待つ。
   * ⚠ **Redis に繋がらない間の `start()` は reject せず、pending のまま待ち続ける**（【実測】redis-server 7.4.7・bullmq 6.3.8、ADR 0449。15秒待っても未決。その間 `onTickError` に
   * ECONNREFUSED が届き、Redis が戻ると resolve した）。接続が拒まれる間は #963 の「reject したらやり直す」は働かない。
   * ⚠ 登録は `start()` の1回だけで、Redis が永続化なしで再起動して scheduler を失っても自動では戻らない（永続化ありなら再開する。README「エラーの通知先」）。
   * ⛔ **`stop()` の後に呼ぶと Error を投げる**（Issue #891）——この driver は使い捨てであり、
   * 再開したい場合は `createBullmqTickDriver(...)` を呼び直すこと。
   */
  start(): Promise<void>;
  /**
   * 繰り返しジョブの登録を（最後の Worker のときだけ）外し、Worker と Queue の接続を閉じる。**`start()` を一度も
   * 呼んでいなくても安全に呼べる。** 一度呼ぶと、この driver は使い捨てになる
   * （以後の `start()` は Error を投げる。Issue #891）。
   *
   * 外す「繰り返しジョブの登録」は、同じ `queueName`・`jobName` の全プロセスで共有しているものである。
   * ADR 0655: **この queue に自分以外の Worker が居るとき（`queue.getWorkers()` で見る）は外さない**——残りの
   * プロセスの tick を止めないため。居ない（最後の1台）ときは、今までどおり外す。
   *
   * ⚠ **今までどおり外してしまう場合**: `getWorkers()` が使えない／判別できない環境（`CLIENT LIST` を禁じた
   * ACL・一部のマネージド Redis など）。そこでは1台の `stop()` が、残りのプロセスの tick を発火させなくする
   * （エラーにもならない）。残りのどれかで新しく `createBullmqTickDriver(...)` を作って `start()` すると、再び登録される。
   * ⚠ 2台が同時に `stop()` すると、互いに相手を見てどちらも外さず、scheduler が1件残りうる。
   * ⚠ 永続化なしの Redis の再起動で scheduler が消える件は、これでは直らない。
   */
  stop(): Promise<void>;
}

const DEFAULT_JOB_NAME = "mnemora-tick";
/** ADR 0548: 完了したジョブを残す件数の既定。 */
const DEFAULT_COMPLETED_JOBS_TO_KEEP = 1000;

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
  const message = `createBullmqTickDriver: concurrency must be a positive integer, got ${String(concurrency)}`;
  // ADR 0525: 型の誤りは TypeError、範囲の誤り（小数・`NaN`・`1` 未満）は RangeError。message は同じ。
  if (typeof concurrency !== "number") {
    throw new TypeError(message);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(message);
  }
  return concurrency;
}

/**
 * `everyMs` の入力を検証する（ADR 0498）。数値で、有限で、`1` 以上、`Number.MAX_SAFE_INTEGER` 以下。
 * 小数は通す（`1.5` は BullMQ が切り捨てて動く。ADR 0477）。負・`1` 未満・`1e21` 以上は、検査しないと
 * `start()` が成功したまま tick が黙って止まる。
 */
function assertEveryMs(everyMs: unknown): asserts everyMs is number {
  const message = `createBullmqTickDriver: everyMs must be a finite number between 1 and Number.MAX_SAFE_INTEGER (milliseconds), got ${String(everyMs)}`;
  // ADR 0525: 数でなければ TypeError、数として不正（非有限・`1` 未満・上限超）は RangeError。message は同じ。
  if (typeof everyMs !== "number") {
    throw new TypeError(message);
  }
  if (!Number.isFinite(everyMs) || everyMs < 1 || everyMs > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(message);
  }
}

/** `jobName` の入力を検証して既定値を補う（ADR 0498）。省略（`undefined`）は既定、渡すなら空でない文字列。 */
function resolveJobName(jobName: unknown): string {
  if (jobName === undefined) {
    return DEFAULT_JOB_NAME;
  }
  const message = `createBullmqTickDriver: jobName must be a non-empty string when given, got ${String(jobName)}`;
  // ADR 0525: 文字列でなければ TypeError、空文字は RangeError。message は同じ。
  if (typeof jobName !== "string") {
    throw new TypeError(message);
  }
  if (jobName.length === 0) {
    throw new RangeError(message);
  }
  return jobName;
}

/** `lockDuration` の入力を検証する（ADR 0548）。省略（`undefined`）は BullMQ の既定に任せる。渡すなら `1` 以上 `MAX_SAFE_INTEGER` 以下の整数。 */
function resolveLockDuration(lockDuration: unknown): number | undefined {
  if (lockDuration === undefined) {
    return undefined;
  }
  const message = `createBullmqTickDriver: lockDuration must be a positive integer (milliseconds), got ${String(lockDuration)}`;
  // ADR 0525: 数でなければ TypeError、数として不正（小数・非有限・`1` 未満・上限超）は RangeError。message は同じ。
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

/** `completedJobsToKeep` の入力を検証して既定値を補う（ADR 0548）。省略（`undefined`）は既定、渡すなら `0` 以上の整数。 */
function resolveCompletedJobsToKeep(completedJobsToKeep: unknown): number {
  if (completedJobsToKeep === undefined) {
    return DEFAULT_COMPLETED_JOBS_TO_KEEP;
  }
  const message = `createBullmqTickDriver: completedJobsToKeep must be a non-negative integer, got ${String(completedJobsToKeep)}`;
  // ADR 0525: 数でなければ TypeError、数として不正（小数・非有限・負・上限超）は RangeError。message は同じ。
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
  // `onTickError` があるときだけ Queue の `'error'` を拾う。無いときに listener を付けると、bullmq の既定の
  // `console.error`（listener が無い `'error'` の落ち先）まで消え、Queue の異常が黙る。
  const onQueueError = opts.onTickError;
  if (onQueueError) {
    queue.on("error", (err) => {
      onQueueError(err);
    });
  }
  // ADR 0655: この driver の Worker を他の Worker と見分けるための、driver ごとに一意な名前。
  // bullmq 6.3.8 は Worker の blocking 接続に `CLIENT SETNAME <prefix>:<base64(queue)>:w:<name>` を付ける
  // （`utils/create-backend.js` の `createBlockingConnection`）ので、`queue.getWorkers()`（CLIENT LIST）が返す各行の
  // `rawname` の末尾に `:w:<この名前>` が付く。`stop()` はそれで「自分」を数えない。
  const workerName = `mnemora-tick-${randomUUID()}`;
  const selfSuffix = `:w:${workerName}`;
  const worker = new Worker(
    opts.queueName,
    async (_job: Job) => {
      const result = await opts.runtime.tick(opts.ctx, opts.tick);
      opts.onTickResult?.(result);
      return result;
    },
    // 🔴 Issue #890: bullmq 6.3.8 の既定 `autorun: true` だと、`start()` を呼ぶ前から Worker が
    // Redis に繋ぎ、キューにあるジョブを処理し始める。`autorun: false` で構築し、
    // `start()` が明示的に `worker.run()` を呼ぶ。
    // ADR 0548: `lockDuration` は渡されたときだけ載せる（省略なら BullMQ の既定）。
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
  // 🔴 processor（= `runtime.tick()`）の throw は `'error'` ではなく `'failed'` で来る（bullmq 6.3.8
  // `worker.js` の `handleFailed`: `this.emit('failed', job, err, 'active')`。実 Redis での実測は
  // `tick-driver.failed.redis.test.ts`）。拾わないと `onTickError` が tick の失敗を取りこぼす。
  // 渡すのは job ではなく error。`'error'` は emit されないので二重には通知しない。
  worker.on("failed", (_job, err) => {
    opts.onTickError?.(err);
  });

  // 起動中または起動済みの `start()` の promise。`null` は「まだ起動していない」（失敗した
  // 起動の後も含む）。同時に呼ばれた `start()` は同じ promise を待つ。
  let starting: Promise<void> | null = null;
  let stopped = false;

  /**
   * ADR 0655: この queue に、自分以外の Worker（別プロセスでも同じプロセスでもよい）が居るか。
   *
   * 根拠（bullmq 6.3.8 を読んだ）: `queue.getWorkers()` は `CLIENT LIST` を読み、接続名が
   * `<prefix>:<base64(queue)>`（名前なしの Worker）または `<prefix>:<base64(queue)>:w:<name>` で始まる行を返す
   * （`queue-getters.js`）。各行の `rawname` が接続名そのもの。自分の Worker には上で一意な `name` を付けたので、
   * `rawname` が `:w:<自分の名前>` で終わる行だけを自分として除く。名前なしの Worker（この driver より古い版）や
   * 他の driver の Worker は「他」と数える。
   *
   * 🔴 **居るかどうか分からないときは「居ない」に倒す＝今までどおり消す**:
   * - `getWorkers()` が throw した（CLIENT LIST を禁じた環境、接続の失敗など）。
   * - 行に `rawname` が無い。bullmq は CLIENT コマンドが未対応のとき throw せず `[{ name: "GCP does not support client list" }]`
   *   という偽の1件を返す（`baseGetClients`）。これを「他の Worker が居る」と読むと、CLIENT の使えない環境で
   *   scheduler が誰にも消されず残るので、読まない。
   * 自分の接続名が付かない環境（SETNAME を無視するプロキシなど）では、自分も他も一覧に出ないので、やはり消す。
   *
   * ⚠ 2台が同時に `stop()` すると、互いに相手を見てどちらも消さず、scheduler が1件残りうる（ADR 0655 の負債）。
   */
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
      // 🔴 Issue #891: `stop()` 済みの Queue/Worker は `close()` 済みで再利用できない。
      // 黙って resolve すると「再開できた」ように見えるため、Error で拒否する。
      if (stopped) {
        throw new Error(
          "createBullmqTickDriver: stop() 済みの driver で start() は呼べない（この driver は使い捨てである）。" +
            " 再開したい場合は createBullmqTickDriver(...) を呼び直すこと。",
        );
      }
      if (starting !== null) {
        return starting;
      }
      // 🔴 Issue #963: 起動が途中で失敗したら「起動済み」の印を残さない（残すと、スケジュールが
      // 無く tick が発火しないまま「起動できた」ように見える）。そのため失敗しうる登録
      // （`upsertJobScheduler`）を**先に**済ませ、Worker は登録が成功した後でだけ走らせる。
      // Worker は一度 `run()` / `close()` すると再利用できない（Issue #891）ので、先に走らせると
      // 片付けようがない。
      const attempt = (async () => {
        // `jobSchedulerId` を固定値にすることで、複数プロセスが同じ `queueName` に対して
        // `start()` を呼んでも冪等に同じスケジュールを指す（上の doc「複数プロセスで動かすとき」参照）。
        // ADR 0548: 完了したジョブは直近 `completedJobsToKeep` 件だけ残す（`removeOnComplete`）。
        // `removeOnFail` は指定しない（失敗したジョブは全部残る）。
        await queue.upsertJobScheduler(
          jobName,
          { every: opts.everyMs },
          { name: jobName, opts: { removeOnComplete: { count: completedJobsToKeep } } },
        );
        // 登録を待つ間に `stop()` された場合は、閉じた Worker を走らせない。
        if (stopped) {
          return;
        }
        // ⚠ `worker.run()` が返す promise は、Worker が閉じるまで resolve しない
        // （bullmq 6.3.8 の `mainLoop` は `worker.close()` で `closing` が立つまで回る）。
        // `await` すると `start()` が `stop()` されるまで返らなくなるため、意図的に await しない。
        // reject は、bullmq 自身が `autorun: true` で行うのと同じ形で `worker` の `"error"`
        // listener（`onTickError` へ流す）に載せる。
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
      // `start()` を一度も呼んでいなくても安全に呼べる（`worker.close()` は `run()` が動いて
      // いなくても素通りする。bullmq 6.3.8 の `worker.js` を読んで確認済み）。
      stopped = true;
      try {
        // ADR 0655: 自分以外の Worker が居るときは、共有の scheduler を消さない（残りの tick を止めない）。
        // 居ない（最後の1台）か、分からないときは消す。
        if (!(await hasOtherWorkers())) {
          await queue.removeJobScheduler(jobName);
        }
      } finally {
        // `worker.close()` が reject しても `queue.close()` は必ず試みる（並べて書くと Queue 側の
        // 接続が開いたまま残る。`tick-driver.stop-cleanup.test.ts` が実測）。
        try {
          await worker.close();
        } finally {
          await queue.close();
        }
      }
    },
  };
}
