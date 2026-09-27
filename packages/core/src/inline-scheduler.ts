import type { Ctx } from "./ctx.js";
import type { OutboxJob, Scheduler } from "./interfaces/scheduler.js";

/**
 * `InlineScheduler` — 既定の Scheduler 実装（docs/architecture.md §3.3・§5.6）。
 *
 * キューを持たず、`enqueue` を呼び出しコンテキストの中で同期的に実行する。これにより
 * Redis も BullMQ も無い最小構成が最初から成立する（Background Cognition を切っても
 * 成立する、という設計方針の実装）。
 *
 * 実際のジョブ処理（抽出・埋め込み等）は呼び出し側が渡す `handler` が行う。
 * `InlineScheduler` 自体はジョブの中身を解釈しない——「運ぶ」役に徹する
 * （docs/architecture.md §5.6 の Scheduler の契約）。
 */
export class InlineScheduler implements Scheduler {
  constructor(private readonly handler: (ctx: Ctx, job: OutboxJob) => Promise<void>) {}

  /** `job` をその場で `handler` に渡して実行し、終わるまで待つ（キューに積まない）。`handler` の例外はそのまま伝わる。 */
  async enqueue(ctx: Ctx, job: OutboxJob): Promise<void> {
    await this.handler(ctx, job);
  }
}
