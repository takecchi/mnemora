import type { Ctx } from "../ctx.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { OutboxJobKind } from "./scheduler.js";

/**
 * OutboxStore — Phase 1（本 PR で追加。docs/architecture.md §3.4・ADR 0005 の
 * transactional outbox パターンの「運搬役」側）。
 *
 * `MemoryStore.createObservationWithOutbox` / `createMemoryWithOutbox` が
 * Observation/Memory の作成と同一トランザクションで `outbox` へジョブを書く一方、
 * `OutboxStore` はその後の「未処理行を claim して処理し、完了/失敗を記録する」側を担う。
 * `runtime.tick(ctx, opts)`（docs/architecture.md §3.3）がこの interface を使う。
 *
 * 契約:
 * - `claimBatch` は同時に複数のワーカーから呼ばれても同じジョブを二重に claim してはならない
 *   （adapter 実装は `SELECT ... FOR UPDATE SKIP LOCKED` 相当で保証する）。
 * - `claimBatch` が返すジョブは `completed_at IS NULL AND failed_at IS NULL` かつ
 *   `available_at <= now` のものに限る。
 * - 🔴 **claim のリース（ADR 0032）**: `claimBatch` は、`claimed_at IS NULL`（一度も
 *   claim されていない）の行に加えて、**`claimed_at` が `opts.leaseMs` 以上前**
 *   （`claimed_at <= opts.now - opts.leaseMs`）の行も返す。`FOR UPDATE SKIP LOCKED`
 *   が保証する行ロックは同一 SQL 文の実行中しか保持されない——claim した文がコミットした
 *   瞬間にロックは解放される。それにもかかわらず一度 claim した行を `claimed_at IS NULL`
 *   だけで再取得不能にすると、claim 後に処理が完了しないまま止まったワーカー
 *   （クラッシュ・ハング）のジョブが `completed_at`/`failed_at` のどちらも付かないまま
 *   **二度と claim されず、どこからも見えなくなる**。リースは、この「見えない停止」を
 *   避けるための時間切れの仕組みである。
 *   **これにより処理は at-least-once になる**——リースが切れる前に処理が完了しなかった
 *   ジョブは、別のワーカー（または同じワーカー）に再び claim され、**同じジョブが
 *   複数回処理されうる**。呼び出し側（`processExtractJob`/`processEmbedJob` 等）は
 *   この重複を前提にしてよい形（冪等）で書くこと。
 *   **下の「Phase 1 では失敗したジョブの自動リトライを行わない」とは別の話**——
 *   あちらは `fail()` で終端状態になった（＝処理を試みて失敗が確定した）ジョブの話、
 *   こちらは終端状態に達しないまま止まったジョブを回収する話である。
 *   **`leaseMs` に既定値は無く、省略できない**——リース長は「何をもって処理が
 *   止まったとみなすか」という運用方針であり、この interface（`packages/core`）が
 *   決めてよい値ではなく、呼び出し側（`runtime.tick` の呼び出し元）が決める
 *   （「採らなかった案」は ADR 0032 参照）。
 * - `complete` / `fail` は対象が既に完了/失敗していても例外を投げない（べき等な終端更新）。
 * - Phase 1 では失敗したジョブの自動リトライを行わない（`fail` は終端状態。本 PR の決定、
 *   PR 本文に記載）。
 */
export interface ClaimOutboxJobsOptions {
  kinds?: OutboxJobKind[];
  limit: number;
  now: Date;
  claimedBy: string;
  /**
   * claim のリース長（ミリ秒）。`claimed_at` からこの時間が経過した行は、まだ
   * `completed_at`/`failed_at` が付いていなくても「止まったワーカーのジョブ」として
   * 再び claim される（ADR 0032）。**必須・既定値なし**——呼び出し側が方針を決めること。
   */
  leaseMs: number;
}

export interface OutboxStore {
  claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
  complete(ctx: Ctx, jobId: string): Promise<void>;
  fail(ctx: Ctx, jobId: string, error: string): Promise<void>;
}
