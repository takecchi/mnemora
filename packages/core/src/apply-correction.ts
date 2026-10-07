import type { MemoryId } from "./ids.js";
import type { EventActor } from "./event.js";
import type { FindCorrectionCandidatesResult } from "./correction-candidates.js";
import type {
  ContestedResolution,
  MarkContestedResult,
  ResolveContestedResult,
} from "./runtime.js";

/**
 * `Runtime.applyCorrection`（[ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)）の入出力。
 *
 * 採用側が `findCorrectionCandidates` の候補から指名した相手（`correctedId`）を受け取り、
 * `markContested`/`resolveContested` を呼ぶだけの薄い orchestration（詳しくは `Runtime.applyCorrection` の doc）。
 *
 * **この口も「相手を選ぶ」ことは一切しない。** `correctedId` は必ず呼び出し側が渡し、`discovery.candidates[0]`
 * を自動的に採る経路は無い（`discovery.candidates` は `correctedId` が居るかの照合にしか使わない）。
 * 訂正してはいけない発話で棄権できず誤爆する危険（ADR 0232）に、候補を機械的に採らないことで応える。
 */

/** `Runtime.applyCorrection` への入力。 */
export interface ApplyCorrectionInput {
  /**
   * `runtime.findCorrectionCandidates(ctx, { text, excludeMemoryIds })` の結果そのまま。
   * **この口自身は `recall()`/`findCorrectionCandidates` を呼ばない**（呼び出し側が先に呼んで渡す）。
   */
  discovery: FindCorrectionCandidatesResult;
  /**
   * 採用側が指名した、**訂正される側**（古いほう）の id。
   *
   * **省略できる。** `undefined` のまま呼ぶと、書き込みを1件も試みずに `{ kind: "awaiting_choice" }` を返す。
   */
  correctedId?: MemoryId | undefined;
  /** 訂正する側（新しい発話・新しい事実）の id。**常に必須。** */
  correctingId: MemoryId;
  /**
   * 「どちらが正しいか」。**省略すると `markContested` だけを呼んで `contested` で止まる**
   * （`resolveContested` は一度も呼ばれない）。渡せば、`markContested` に続けて `resolveContested` まで呼ぶ。
   *
   * ⚠ **`{ kind: "supersede", winnerId }` の `winnerId` が `correctedId`・`correctingId` のどちらとも
   * 合わないときは、`RangeError` を投げる**（`resolveContested` が投げるのと同じ型と文言）。
   * 書き込みの前に検査するので、`markContested` は呼ばれず何も書かれない（ADR 0446）。
   *
   * `markContested` した直後に `resolution` を渡さず、後から別の `applyCorrection` 呼び出しで
   * `resolution` を渡す2段の使い方もできる。2回目でも `markContested` は呼ばれる（1回目で mark 済みかを
   * 記憶しない）が、対象は既に `status: 'contested'` なので {@link MarkContestedResult} は `ineligible` を
   * 返すだけで書き込みは起きず、`resolveContested` 側は正常に解決へ進む。
   */
  resolution?: ContestedResolution | undefined;
  /**
   * `markContested`/`resolveContested` の**両方**に、`opts.reason` としてそのまま渡す（ADR 0238）。
   *
   * **この口は監査理由を自動生成しない。** {@link buildCorrectionReason} で組み立てた文字列（または任意の自由文）を
   * 渡す。推測して書き込むと、この口が「相手を選ぶ」判断を持つことに近づいてしまう。
   */
  reason?: string | undefined;
  /** `markContested`/`resolveContested` の両方に渡す `memory_events.actor`。 */
  actor?: EventActor | undefined;
}

/**
 * `Runtime.applyCorrection` の結果（「まだ選ばれていない」「候補に居ない」「対にしただけ」
 * 「対にして解決まで進めた」を1つの `boolean`/例外に潰さない。ADR 0008）。
 *
 * - `"awaiting_choice"` — `correctedId` が渡されなかった。**書き込みは1件もしていない。**
 * - `"not_a_candidate"` — `correctedId` は渡されたが、`discovery.candidates` に居なかった。
 *   **書き込みは1件もしていない。**（照合は文字列の完全一致が基本。完全一致が無くても、大文字小文字を
 *   無視してちょうど1件の候補に一致し、store の `get` が両者を同じ記憶と言えば、その候補として扱う。ADR 0446）
 * - `"contested"` — `correctedId` は候補に居た。`markContested` を呼んだ（{@link MarkContestedResult} の
 *   `contested`/`ineligible`/`conflict`/`not_attempted` をそのまま運ぶ）。**`resolution` が渡されなかったので
 *   `resolveContested` は一度も呼んでいない。**
 * - `"resolved"` — `correctedId` は候補に居て、`resolution` も渡された。`markContested` に続けて
 *   `resolveContested` を呼んだ（{@link ResolveContestedResult} もそのまま運ぶ）。
 *   ⚠ **`"resolved"` という kind 名は「`resolveContested` まで呼んだ」ことを意味するだけで、
 *   実際に解決が成功したことは意味しない。**成否は `resolveResult.outcome.kind` を見ること
 *   （`ineligible`/`conflict`/`not_attempted` を、この口が別の顔（例外・`false`）に変換しない）。
 */
export type ApplyCorrectionResult =
  | { kind: "awaiting_choice" }
  | { kind: "not_a_candidate"; correctedId: MemoryId }
  | {
      kind: "contested";
      correctedId: MemoryId;
      correctingId: MemoryId;
      /** 指名した候補の `CorrectionCandidate.recallRank`（詰め直していない生の順位）。 */
      chosenRecallRank: number;
      markResult: MarkContestedResult;
    }
  | {
      kind: "resolved";
      correctedId: MemoryId;
      correctingId: MemoryId;
      chosenRecallRank: number;
      markResult: MarkContestedResult;
      resolveResult: ResolveContestedResult;
    };

/** `buildCorrectionReason`（[ADR 0238](../../../docs/decisions/0238-correction-choice-rationale-in-events.md)）への入力。 */
export interface CorrectionReasonInput {
  /** `applyCorrection` に渡すのと同じ `discovery`。`recallId`/`candidates.length` を運ぶ。 */
  discovery: FindCorrectionCandidatesResult;
  /**
   * 指名した候補の `CorrectionCandidate.recallRank`。呼び出し側が
   * `discovery.candidates.find((c) => c.memoryId === correctedId)?.recallRank` で引く。
   */
  chosenRecallRank: number;
  /** `ApplyCorrectionInput.correctedId` と同じ値。 */
  correctedId: MemoryId;
  /** `ApplyCorrectionInput.correctingId` と同じ値。 */
  correctingId: MemoryId;
  /** どちらへ倒すか。**まだ決めていなければ `null`**（`markContested` だけを呼ぶ時点ではまだ勝者が無い）。 */
  resolution: ContestedResolution | null;
}

/**
 * 選んだ根拠（`recallId`・順位・候補の数・どちらへ倒したか）を、`memory_events.meta.note` と
 * `RecallResult.explain` の両方から辿れる形の1行にする（ADR 0238、ADR 0242）。
 *
 * 形式は `key=value / ...` の1行、4要素。`winner` の語彙は `Runtime` に「どちらが元の発話か」という
 * 概念が無いため、`correctedId`/`correctingId` に基づく `corrected`/`correcting`/`both_active`/`pending`。
 *
 * `winner` の値:
 * - `resolution === null` → `"pending"`。
 * - `resolution.kind === "both_active"` → `"both_active"`。
 * - `resolution.kind === "supersede"` → `winnerId === correctingId` なら `"correcting"`、
 *   そうでなければ `"corrected"`。ただし `winnerId` がどちらの id とも文字列では一致せず、大文字小文字を
 *   無視すると `correctingId` だけに一致するときも `"correcting"`（ADR 0446）。
 *
 * ⚠ **`score.total` は載せない。**スコアの閾値は「訂正すべき」と「訂正してはいけない」を分離しない
 * （ADR 0232）ので、生スコアを載せると「スコアが高かったから選ばれた」という誤った説明を後から読む側に
 * 与えてしまう。スコアの実際の値は `recallId` を辿って `RecallRecord.returnedMemories` から読む。
 */
export function buildCorrectionReason(input: CorrectionReasonInput): string {
  const winner: string =
    input.resolution === null
      ? "pending"
      : input.resolution.kind === "both_active"
        ? "both_active"
        : supersedeWinnerLabel(input.resolution.winnerId, input.correctedId, input.correctingId);
  return (
    `chosenRecallRank=${input.chosenRecallRank} / candidates=${input.discovery.candidates.length} / ` +
    `recallId=${input.discovery.recallId} / winner=${winner}`
  );
}

/**
 * `supersede` の勝者が訂正する側か訂正される側か。文字列がそのまま一致する側を採る。どちらとも一致しないときだけ、
 * 大文字小文字を無視して**どちらか一方だけ**に一致する側を採る。`@mnemora/postgres` は uuid を大文字小文字を
 * 区別せずに比べ、`resolveContested` は大文字の `winnerId` を勝者として受け付ける。完全一致だけで比べると、
 * 実際には訂正する側が勝っているのに `winner=corrected` と書き、監査の記録が実際と逆になる（ADR 0446）。
 * それでも決まらない（どちらとも合わない・両方に合う）ときは `"corrected"`。
 */
function supersedeWinnerLabel(
  winnerId: MemoryId,
  correctedId: MemoryId,
  correctingId: MemoryId,
): "correcting" | "corrected" {
  if (winnerId === correctingId) return "correcting";
  if (winnerId === correctedId) return "corrected";
  const lower = winnerId.toLowerCase();
  const isCorrecting = correctingId.toLowerCase() === lower;
  const isCorrected = correctedId.toLowerCase() === lower;
  return isCorrecting && !isCorrected ? "correcting" : "corrected";
}

/**
 * zod スキーマは置かない。理由は `correction-candidates.ts` 末尾の注記と同じで、`Runtime` の操作の
 * 結果型には schema が無く、`ApplyCorrectionResult` もそれらを運ぶだけの結果であるため。
 */
