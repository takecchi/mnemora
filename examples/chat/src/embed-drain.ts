import type { Ctx, Runtime } from "@mnemora/core";

/**
 * `runtime.tick` に渡す claim リース長（ADR 0032）。この harness の呼び出し側として決めた方針で、`packages/core` の既定値ではない。
 *
 * 1回の embed/extract ジョブは、`openai` SDK の既定（1リクエスト10分・自動リトライ2回）まで含めると最大30分は正常に処理中でありうる。
 * リースがこれより短いと、生きているワーカーのジョブを止まったと誤判定して奪い、at-least-once の重複を招く。
 * 無用に短くしない。
 */
const EMBED_DRAIN_LEASE_MS = 30 * 60 * 1000;

export interface DrainResult {
  ticks: number;
  totalProcessed: number;
  totalFailed: number;
  firstTickProcessed: number;
}

const DEFAULT_MAX_WAIT_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface DrainEmbedTicksOptions {
  /**
   * 呼び出し元が把握している、今回処理されるはずの embed ジョブ件数。
   * `runtime.observe()`/`runtime.consolidate()` が返す `memoryIds` を積算して渡す。
   *
   * 渡すと、drain 終了時に `totalProcessed + totalFailed` と比較し、一致しなければ例外を投げる。
   * embed 自体の失敗（入力長超過など）は `totalFailed` に数えるので「揃わなかった」とは扱わない。
   * 捕まえたいのは claim 自体が0件になる競合で、embed が成功したかどうかではない。
   */
  expectedProcessed?: number;
  /**
   * 既定 `true`。`expectedProcessed` を満たさなかったとき、実時計が1ms以上進むのを待って drain し直す。
   * `packages/core` の既定 `systemClock` を使う呼び出し元向け。
   *
   * `MutableClock`（止まった時計）を注入している呼び出し元では `false` を渡すこと。
   * `.set()` するまで動かない時計では待っても無意味で、`maxWaitMs` を消費して最後は必ず例外になる。
   * 代わりに drain の直前に自分で `clock.set(clockPastRecentDbWrites())` を呼ぶ。
   */
  waitForClockToAdvance?: boolean;
  maxWaitMs?: number;
}

/**
 * 直近に書いた outbox ジョブの `available_at` を確実に追い越す、ミリ秒精度の `Date` を返す。
 *
 * 歴史的な理由で残している（ADR 0559）。かつて `available_at` は SQL の `now()`（マイクロ秒精度）で書かれ、
 * claim の `opts.now` は JS の `Date`（ミリ秒、切り捨て）だったため、同じ 1ms の枠に収まると `floor(T2)` が `T1` より
 * 小さくなりえた。そうなると claim が1件も進まず、`drainEmbedTicks` は `processed === 0` を「もう無い」と読んで静かに抜ける。
 * いまは runtime が注入した時計の値を store に渡すので、この機構は無い。
 *
 * `floor(T2) + 1` を使う。`floor(x) + 1 > x` は恒等式なので、書き込みの応答を受け取った後に呼ぶ限り決定的に安全。
 * 前提は、アプリと Postgres が同じホストの実時計を共有すること。
 *
 * `nowMs` を引数にしているのは、テストが時刻の読み取りをモックせずに境界条件を検査するため。
 */
export function clockPastRecentDbWrites(nowMs: number = Date.now()): Date {
  return new Date(nowMs + 1);
}

/**
 * `tick({kinds:['embed']})` を `processed === 0` になるまで繰り返す。
 *
 * `tick()` の既定 `limit` は50で、51件目以降は埋め込まれないまま `pending` に残り、ANN 候補にすらならない。
 * 1回の `tick()` では「まだ残っているかもしれない」ことしか分からないので、干上がるまで回す責任は、
 * 単発の安全弁を持つ `packages/core` ではなく、バッチ的な呼び出し側にある（ADR 0021）。
 *
 * `processed === 0` は、ジョブが無いことの証拠にならない（当時の事実、ADR 0559）。`available_at` と `opts.now` が
 * 同じ ms に収まると、ジョブが残っていても `processed === 0` になる。`options.expectedProcessed` を渡すと、
 * この関数自身がそれを検査する。渡さない呼び出し元は従来どおり `processed === 0` だけで判定する。
 */
export async function drainEmbedTicks(
  runtime: Runtime,
  ctx: Ctx,
  options: DrainEmbedTicksOptions = {},
): Promise<DrainResult> {
  const waitForClockToAdvance = options.waitForClockToAdvance ?? true;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  let ticks = 0;
  let totalProcessed = 0;
  let totalFailed = 0;
  let firstTickProcessed = 0;

  async function drainOnce(): Promise<void> {
    for (;;) {
      const result = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: EMBED_DRAIN_LEASE_MS });
      ticks += 1;
      totalProcessed += result.processed;
      totalFailed += result.failed;
      if (ticks === 1) {
        firstTickProcessed = result.processed;
      }
      if (result.processed === 0) {
        break;
      }
    }
  }

  // `processed + failed` で見るのは、embed 自体の失敗を「揃った」うちに数え、claim 自体の欠落だけを検査するため。
  const isSatisfied = (): boolean =>
    options.expectedProcessed === undefined ||
    totalProcessed + totalFailed === options.expectedProcessed;

  await drainOnce();

  if (!isSatisfied() && waitForClockToAdvance) {
    const deadline = Date.now() + maxWaitMs;
    while (!isSatisfied() && Date.now() < deadline) {
      // 実時計が1ms以上進むのを待ってから drain し直す。`systemClock` は呼ぶたびに実時刻を読むので、これだけで ms 競合を抜けられる。
      await sleep(2);
      await drainOnce();
    }
  }

  if (!isSatisfied()) {
    throw new Error(
      `drainEmbedTicks: embed ジョブが ${String(options.expectedProcessed)} 件処理される` +
        `はずが、claim されて終端まで進んだのは ${String(totalProcessed + totalFailed)} 件` +
        `(processed=${String(totalProcessed)}, failed=${String(totalFailed)})しかなかった` +
        `(ticks=${String(ticks)})。outbox の available_at と clock の競合、` +
        `または呼び出し側が渡した expectedProcessed 自体の見積もり違いを疑うこと。`,
    );
  }

  return { ticks, totalProcessed, totalFailed, firstTickProcessed };
}
