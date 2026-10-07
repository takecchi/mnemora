import type { Ctx } from "./ctx.js";
import type { OutboxJob, Scheduler } from "./interfaces/scheduler.js";

/**
 * `InlineScheduler` — 既定の Scheduler 実装。
 *
 * キューを持たず、`enqueue` を呼び出しコンテキストの中で同期的に実行する。
 * ジョブの中身は解釈せず、呼び出し側が渡す `handler` に任せる。
 */
export class InlineScheduler implements Scheduler {
  constructor(private readonly handler: (ctx: Ctx, job: OutboxJob) => Promise<void>) {}

  /** `job` をその場で `handler` に渡して実行し、終わるまで待つ（キューに積まない）。`handler` の例外はそのまま伝わる。 */
  async enqueue(ctx: Ctx, job: OutboxJob): Promise<void> {
    await this.handler(ctx, job);
  }
}
