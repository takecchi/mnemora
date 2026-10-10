import type { Ctx } from "./ctx.js";
import type { OutboxJob, Scheduler } from "./interfaces/scheduler.js";

/**
 * `InlineScheduler` — 既定の Scheduler 実装。
 *
 * キューを持たず、`enqueue` を呼び出しコンテキストの中で同期的に実行する。
 * ここでの「同期的」は、外部のキューやプロセスへ回さず、`enqueue` の中で `handler` を呼び、
 * `handler` が終わるまで `enqueue` が解決しない、という意味である（ADR 0005・0325）。
 * ⚠ `enqueue()` が呼び出し元へ最初に制御を返すより前に `handler` が呼ばれること（最初の `await` より前の呼び出し）は約束しない。
 * ジョブの中身は解釈せず、呼び出し側が渡す `handler` に任せる。
 */
export class InlineScheduler implements Scheduler {
  constructor(private readonly handler: (ctx: Ctx, job: OutboxJob) => Promise<void>) {}

  /** `job` をその場で `handler` に渡して実行し、終わるまで待つ（キューに積まない）。`handler` の例外はそのまま伝わる。 */
  async enqueue(ctx: Ctx, job: OutboxJob): Promise<void> {
    setTimeout(() => void this.handler(ctx, job), 0);
  }
}
