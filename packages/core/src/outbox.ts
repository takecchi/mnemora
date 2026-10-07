import { z } from "zod";
import type { OutboxJobKind } from "./interfaces/scheduler.js";

/**
 * `outbox` テーブルの1行を core の型として表したもの（docs/memory-model.md §10、ADR 0005）。
 *
 * `MemoryStore` が新規作成時に返し、`OutboxStore` が claim/complete/fail で操作する対象。
 */
export interface OutboxJobRecord {
  /** ジョブの id。 */
  id: string;
  /**
   * ジョブが属するテナント。
   *
   * ⚠ `ctx.tenantId: ""` で積んだジョブでは `""` になり、{@link OutboxJobRecordSchema}（`min(1)`）を通らない
   * （入力の空文字は `Ctx` の doc のとおり受け付ける）。
   */
  tenantId: string;
  /** ジョブの種別（{@link OutboxJobKind}）。 */
  kind: OutboxJobKind;
  /** ジョブの中身（種別ごとの JSON）。 */
  payload: Record<string, unknown>;
  /** この時刻を過ぎたら claim できる。 */
  availableAt: Date;
  /** 最後に claim された時刻。一度も claim されていなければ `null`（リースの判定に使う）。 */
  claimedAt?: Date | null;
  /**
   * 最後に claim した worker の名前。
   *
   * ⚠ `claimBatch` に `claimedBy: ""` を渡すと `""` になり、{@link OutboxJobRecordSchema}（`min(1)`）を通らない
   * （入力の空文字は拒まない。`ClaimOutboxJobsOptions.claimedBy` の doc）。
   */
  claimedBy?: string | null;
  /** claim された回数。claim のたびに1増える。`complete`/`fail` の CAS に使う（上限は無い）。 */
  attempts: number;
  /** 完了にした時刻。未完了なら `null`。 */
  completedAt?: Date | null;
  /** 失敗（終端）にした時刻。失敗していなければ `null`。 */
  failedAt?: Date | null;
  /**
   * `fail` に渡したエラーの文字列。
   *
   * ⚠ **利用者の本文を含みうる。** `tick()` は処理の失敗の例外の文面（`cause` の連鎖を含む）を載せる。
   * `describeFailure`（`failure-description.ts`、ADR 0363）は、drizzle が包んだエラー文の `params:` 以降
   * （失敗したクエリに渡した値そのもの）を `(omitted by mnemora, N chars)` という印に置き換え、
   * 戻り値全体を4096文字で切り詰める。
   * **それでも本文が丸ごと載りうる経路は残っている**（ADR 0363「塞がらない経路」）:
   * `@mnemora/openai` の拒否の文面（`OpenAILLMProviderError`、ADR 0075）や、pg の生エラーの
   * 型変換失敗のメッセージ（`invalid input syntax for type ... : "<値>"`）は、`params:` という
   * 目印を持たないため削れず、長さの上限だけで抑えている。
   * ⟹ **この欄は、「本文の断片が載りうるもの」として扱うこと。**「本文が絶対に載らない」
   * という約束にはなっていない。
   */
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
