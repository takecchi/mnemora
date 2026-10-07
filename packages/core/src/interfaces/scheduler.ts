import type { Ctx } from "../ctx.js";

/**
 * outbox ジョブの種別（docs/memory-model.md §10 の `outbox.kind` 列）。開いた判別可能ユニオンで、
 * CHECK 制約に相当する閉じた型は core に持たせない。
 *
 * 🔴 **この型に名前が在ることは、`runtime.tick` がそれを処理することを意味しない。**
 * **`tick` が処理する kind の唯一の出所は `TICK_SUPPORTED_JOB_KINDS`**（`../runtime.js`）である。
 * **ここでその一覧を数え直さないこと**——散文の写しは kind が増えた瞬間に黙って嘘になる。
 * `tick` に渡した kind がそこに無かったときの倒れ方（終端で失敗し、`TickResult.unsupported` に出る）は ADR 0082。
 */
export type OutboxJobKind = "extract" | "embed" | "consolidate" | "reflect" | (string & {});

/** `Scheduler.enqueue` に渡す、outbox の1ジョブ。 */
export interface OutboxJob {
  /** ジョブの id（`outbox` の行の id）。 */
  id: string;
  /** ジョブが属するテナント。 */
  tenantId: string;
  /** ジョブの種別（{@link OutboxJobKind}）。 */
  kind: OutboxJobKind;
  /** ジョブの中身（種別ごとの JSON）。 */
  payload: Record<string, unknown>;
  /** 処理してよい最早の時刻（`outbox.available_at` に対応する）。省略できる。⚠ `InlineScheduler` はこの値を見ず、その場で実行する。 */
  availableAt?: Date;
}

/**
 * Scheduler（docs/architecture.md §5.6）。この interface の実装は `InlineScheduler` だけである。
 * `@mnemora/bullmq` はこの interface を実装せず、BullMQ のジョブで `runtime.tick()` を駆動する（ADR 0325）。
 *
 * 契約:
 * - `enqueue` はジョブの重複投入に対して冪等でなくてよい（重複排除は消費側/extractor の冪等制約が担う）。
 */
export interface Scheduler {
  /** `job` を処理に回す。重複投入に対して冪等でなくてよい（上の契約）。 */
  enqueue(ctx: Ctx, job: OutboxJob): Promise<void>;
}
