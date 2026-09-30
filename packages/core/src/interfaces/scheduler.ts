import type { Ctx } from "../ctx.js";

/**
 * outbox ジョブの種別（docs/memory-model.md §10 の `outbox.kind` 列）。
 * `observations.kind` と同様、開いた判別可能ユニオンとして扱い、CHECK 制約に
 * 相当する閉じた型を core には持たせない。
 *
 * 🔴 **この型に名前が在ることは、`runtime.tick` がそれを処理することを意味しない。**
 * 名指しの列挙は「`outbox.kind` にどんな値が入りうるか」の見取り図であって、
 * 「誰が処理するか」ではない（issue #105: `consolidate` が在るのを見て「積めば
 * `tick` が処理してくれる」と読まれた。実際に読み違えた利用者が居る）。
 *
 * **`tick` が処理する kind の唯一の出所は `TICK_SUPPORTED_JOB_KINDS`**
 * （`../runtime.js`）である。**ここでその一覧を数え直さないこと**——散文の写しは
 * kind が増えた瞬間に黙って嘘になる。`tick` に渡した kind がそこに無かったときの
 * 倒れ方（終端で失敗し、`TickResult.unsupported` に名指しで出る）は ADR 0082。
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
  availableAt?: Date | undefined;
}

/**
 * Scheduler — interface は Phase 1、既定実装は `InlineScheduler`
 * （docs/architecture.md §5.6）。**この interface の実装は、今も `InlineScheduler` だけである。**
 * BullMQ は `Scheduler` の実装としては来なかった——`@mnemora/bullmq`（npm には未公開）は
 * この interface を実装せず、BullMQ のジョブで `runtime.tick()` を駆動する
 * （[ADR 0325](../../../../docs/decisions/0325-bullmq-tick-driver.md)）。
 *
 * 契約:
 * - `enqueue` はジョブの重複投入に対して冪等でなくてよい（重複排除は消費側/extractor の
 *   冪等制約が担う）。
 */
export interface Scheduler {
  /** `job` を処理に回す。重複投入に対して冪等でなくてよい（上の契約）。 */
  enqueue(ctx: Ctx, job: OutboxJob): Promise<void>;
}
