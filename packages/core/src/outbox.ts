import { z } from "zod";
import type { OutboxJobKind } from "./interfaces/scheduler.js";

/**
 * `outbox` テーブルの1行を core の型として表したもの（docs/memory-model.md §10、ADR 0005）。
 *
 * `MemoryStore.createObservationWithOutbox` / `createMemoryWithOutbox` が新規作成時に返し、
 * `OutboxStore` が claim/complete/fail で操作する対象。
 */
export interface OutboxJobRecord {
  /** ジョブの id。 */
  id: string;
  /** ジョブが属するテナント。 */
  tenantId: string;
  /** ジョブの種別（{@link OutboxJobKind}）。 */
  kind: OutboxJobKind;
  /** ジョブの中身（種別ごとの JSON）。 */
  payload: Record<string, unknown>;
  /** この時刻を過ぎたら claim できる。 */
  availableAt: Date;
  /** 最後に claim された時刻。一度も claim されていなければ `null`（リースの判定に使う）。 */
  claimedAt?: Date | null;
  /** 最後に claim した worker の名前。 */
  claimedBy?: string | null;
  /** claim された回数。claim のたびに1増える。`complete`/`fail` の CAS に使う（上限は無い）。 */
  attempts: number;
  /** 完了にした時刻。未完了なら `null`。 */
  completedAt?: Date | null;
  /** 失敗（終端）にした時刻。失敗していなければ `null`。 */
  failedAt?: Date | null;
  /** `fail` に渡したエラーの文字列。 */
  lastError?: string | null;
  /** 積んだ時刻。 */
  createdAt: Date;
}

/** `OutboxJobRecord` の zod スキーマ。値を実行時に検査するときに使う（型 `OutboxJobRecord` と揃えてある）。 */
export const OutboxJobRecordSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  kind: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  availableAt: z.date(),
  claimedAt: z.date().nullable().optional(),
  claimedBy: z.string().min(1).nullable().optional(),
  attempts: z.number().int().nonnegative(),
  completedAt: z.date().nullable().optional(),
  failedAt: z.date().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.date(),
}) satisfies z.ZodType<OutboxJobRecord>;
