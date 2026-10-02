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
 * tick の失敗（`runtime.tick()` の throw）と、Worker・Queue の異常（接続の失敗など）は、`onTickError` に
 * 届く。成功した tick の結果は `onTickResult` に届く（どちらも省略可）。詳しくは `CreateBullmqTickDriverOptions` の各 doc。
 *
 * ⚠ **`onTickError` は、tick の中の個々のジョブ（outbox の行）の失敗を知らせない。** tick が throw しなければ鳴らない。
 * 個々のジョブの失敗は、`onTickResult` の `TickResult.failed`・`unsupported` と、outbox の `last_error` 列で見る。
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
 *
 * 🔴 **1台の `stop()` が、全プロセスの予定を止める**（今の振る舞い。【実測】redis-server 7.4.7・bullmq 6.3.8、ADR 0449。新しい driver を `start()` した後に古い driver を `stop()` する rolling deploy の順でも消える）。
 * `stop()` は共有の scheduler を `queue.removeJobScheduler(jobName)` で消すので、他のプロセスの Worker は
 * 動いたままでも tick のジョブが発火しなくなる。エラーにもならない。動いている driver の `start()` は冪等で
 * 登録し直さないので、残りのどれかで新しい driver を作って `start()` すると再び登録される。
 * {@link BullmqTickDriver.stop} の doc 参照。
 *
 * 🔴 **`queueName` か `jobName` は、テナント（`ctx`）ごとに分けること**（【実測】redis-server 7.4.7・bullmq 6.3.8、ADR 0449。後から `start()` した driver の `everyMs` で scheduler が置き換わり、先に動いていた driver の間隔も変わる）。
 * Worker はジョブの中身を見ずに、自分の `ctx` で `runtime.tick()` を呼ぶ。テナントの違う driver が同じ
 * `queueName` と同じ `jobName`（既定 `"mnemora-tick"`）を使うと、scheduler は1つに上書きされ（`everyMs` は最後に
 * `start()` した driver の値）、1回の発火はどれか1つのテナントの tick にしかならない。
 *
 * ## 完了したジョブは直近 1000 件だけ残る（失敗したジョブは全部残る）

ADR 0548: この driver は繰り返しジョブの template（`upsertJobScheduler` の第3引数）に `removeOnComplete: { count: 1000 }`
を既定で入れる。完了したジョブは新しい順に 1000 件だけ Redis に残り、それより古いものは BullMQ が消す
（`completedJobsToKeep` で件数を変えられる）。以前（ADR 0449 まで）は指定が無く、完了したジョブも全部残った
（`everyMs` ごとに1件ずつ溜まった）。
**`removeOnFail` は指定していない。** BullMQ 6.3.8 は指定が無いと失敗したジョブを全部残す
（`redis-queue-backend.js` の `getKeepJobs` が `{ count: -1 }` を返す）。失敗は調べる材料なので残し、消す口は足していない。
溜まるのが気になるなら、同じ `queueName` の `Queue` を自分で作り、`queue.clean(grace, limit, "failed")` を定期的に呼ぶ
（README「完了したジョブは直近 1000 件だけ残る」）。
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
   * 切り捨てた間隔で動く）。数値の文字列（`"50"`）は断る。以前は検査せず、【実測】（ADR 0477。redis-server 7.4.7・
   * bullmq 6.3.8）負の値・`1` 未満の小数・`1e21` では `start()` が成功したまま tick が数回で黙って止まった
   * （`onTickError` にも届かない）ので、その入力を構築時に断る。
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
   * 繰り返しジョブの template に入る。ADR 0548: 以前は指定が無く、完了したジョブが全部残った。
   *
   * `0` 以上の整数でなければ構築時に投げる（ADR 0525: 数でなければ `TypeError`、小数・`NaN`・`Infinity`・負・
   * `Number.MAX_SAFE_INTEGER` 超なら `RangeError`）。`0` は完了したらすぐ消す。以前の「全部残す」に近づけるなら
   * `Number.MAX_SAFE_INTEGER` を渡す。失敗したジョブ（`removeOnFail`）は、この欄では変わらない（全部残る）。
   */
  completedJobsToKeep?: number | undefined;
  /**
   * 繰り返しジョブの名前・`jobId`。既定 `"mnemora-tick"`。
   *
   * ⚠ ADR 0498: **省略（`undefined`）なら既定。渡すなら空でない文字列でなければ、構築時に投げる。**（ADR 0525: 文字列でなければ `TypeError`、空文字なら `RangeError`） 以前は空文字が
   * `??` で既定に倒れずそのまま scheduler の id になり、【実測】（ADR 0477）`start()` が成功したまま tick が
   * 1回で黙って止まった。`:` を含む名前・空白・日本語・300 文字は動くので断らない。
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
   *   `'failed'` を拾って **job ではなく error だけ**を渡す。以前はこの経路が届かず、tick の失敗が
   *   誰にも見えなかった。失敗した tick のジョブは BullMQ 側に failed として残るが、繰り返しジョブは
   *   次の発火でまた tick する（この driver は再試行を足していない）。
   * - Worker が `'error'` を emit した（Redis 接続の異常、`worker.run()` の reject など）。
   *
   * - Queue が `'error'` を emit した（繰り返しジョブの登録に使う Queue の Redis 接続の異常など）。
   *   以前は Queue に listener が無く、bullmq が `console.error` へ固定で出すだけだった。
   *
   * 🔴 **`onTickError` を渡さないとき、Queue には listener を付けない。** 付けると bullmq（6.3.8 の
   * `QueueBase.emit`。listener の無い `'error'` は EventEmitter が throw し、それを捕まえて `console.error`
   * へ出す）の既定の出力が消え、Queue の異常が完全に黙る。渡していなければ従来どおり `console.error` に出る。
   * （Worker は従来から常に listener を付けており、`onTickError` が無ければ Worker の異常は黙る。そこは変えていない。）
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
   * 繰り返しジョブの登録を外し、Worker と Queue の接続を閉じる。**`start()` を一度も
   * 呼んでいなくても安全に呼べる。** 一度呼ぶと、この driver は使い捨てになる
   * （以後の `start()` は Error を投げる。Issue #891）。
   *
   * ⚠ **外す「繰り返しジョブの登録」は、同じ `queueName`・`jobName` の全プロセスで共有しているものである。**
   * 複数のプロセスで動かしているとき、1台がこれを呼ぶと、残りのプロセスの Worker は動いたままでも tick が
   * 発火しなくなる（エラーにもならない）。動いている driver の `start()` は冪等で登録し直さないので、
   * 残りのどれかで新しく `createBullmqTickDriver(...)` を作って `start()` すると、再び登録される。
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
    // ADR 0548: `lockDuration` は渡されたときだけ載せる（省略なら BullMQ の既定）。
    {
      connection: opts.connection,
      concurrency,
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
        // ADR 0548: 完了したジョブは直近 `completedJobsToKeep` 件だけ残す（`removeOnComplete`）。
        // `removeOnFail` は指定しない（失敗したジョブは従来どおり全部残る）。
        await queue.upsertJobScheduler(
          jobName,
          { every: opts.everyMs },
          { name: jobName, opts: { removeOnComplete: { count: completedJobsToKeep } } },
        );
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
