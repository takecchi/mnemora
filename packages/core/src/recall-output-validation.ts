import type { z } from "zod";
import { RecallResultSchema } from "./recall.js";
import { matchesStoreErrorKind } from "./store-error-kind.js";
import type { RecallOutputValidation, RecallOutputValidationIssue } from "./recall.js";

/**
 * `recall()` の戻り値を検証するときの倒れ方（ADR 0098）。
 *
 * - `"off"` — 検証しない。`RecallResult.outputValidation` は `undefined`。
 * - `"report"` — 検証し、結果を `RecallResult.outputValidation` に載せる。**例外は投げない。**
 * - `"throw"` — 検証し、落ちていたら {@link RecallOutputValidationError} を投げる。
 *
 * **既定は `"report"`**（{@link DEFAULT_RECALL_OUTPUT_VALIDATION}）。既定を `"throw"` にすると、
 * 動いていた呼び出しが例外になる公開 API の破壊的変更になるため。
 */
export type RecallOutputValidationMode = "off" | "report" | "throw";

/** {@link RecallOutputValidationMode} の既定値。 */
export const DEFAULT_RECALL_OUTPUT_VALIDATION: RecallOutputValidationMode = "report";

/**
 * `validateRecallOutput` が `mode: "throw"` で検証に落ちたときに投げる例外（ADR 0098）。
 *
 * 検証は段6（`MemoryStore.createRecall`）の書き込みの**後**に走る。`"throw"` でも `recalls` の行は
 * 残るので、`recallId` で呼び出し側が相関を取れる。
 */
export class RecallOutputValidationError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。判定は `instanceof` ではなく {@link isRecallOutputValidationError} で行う。 */
  readonly kind = "recall_output_validation" as const;
  /** 検証に落ちた箇所の一覧（`path` と `message`）。 */
  readonly issues: readonly RecallOutputValidationIssue[];
  /** 既に書き込まれた `recalls` の行の id。 */
  readonly recallId: string;

  constructor(issues: readonly RecallOutputValidationIssue[], recallId: string) {
    super(
      `recall: output failed validation (recallId: ${recallId}): ` +
        issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
    this.name = "RecallOutputValidationError";
    this.issues = issues;
    this.recallId = recallId;
  }
}

/**
 * 受け取ったものが {@link RecallOutputValidationError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * core が2つの版に分かれていても、`kind` がまだ無い古い版が投げたものでも効く。
 */
export function isRecallOutputValidationError(
  value: unknown,
): value is RecallOutputValidationError {
  return matchesStoreErrorKind(value, "recall_output_validation", "RecallOutputValidationError");
}

function toValidationIssues(error: z.ZodError): RecallOutputValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * `recall()` の戻り値（`outputValidation` を載せる前の draft）を検証する純関数（ADR 0098）。
 *
 * `draft` は `unknown` として受け取り、`RecallResultSchema.safeParse` に通す。
 * **`draft` の値は書き換えない**（壊れていることを見えなくしないため。ADR 0097）。
 *
 * @returns `mode: "off"` のときだけ `undefined`。それ以外は検証結果。
 *   `mode: "throw"` で検証に落ちた場合は {@link RecallOutputValidationError} を投げる。
 */
export function validateRecallOutput(
  draft: unknown,
  mode: RecallOutputValidationMode,
  recallId: string,
): RecallOutputValidation | undefined {
  if (mode === "off") {
    return undefined;
  }

  const result = RecallResultSchema.safeParse(draft);
  if (result.success) {
    return { ok: true, issues: [] };
  }

  const issues = toValidationIssues(result.error);
  if (mode === "throw") {
    throw new RecallOutputValidationError(issues, recallId);
  }
  return { ok: false, issues };
}
