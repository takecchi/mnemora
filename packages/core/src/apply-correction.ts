import type { MemoryId } from "./ids.js";
import type { EventActor } from "./event.js";
import type { FindCorrectionCandidatesResult } from "./correction-candidates.js";
import type {
  ContestedResolution,
  MarkContestedResult,
  ResolveContestedResult,
} from "./runtime.js";

/**
 * `Runtime.applyCorrection`（北極星「目指す姿」項目5、Issue #369、[ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)）の入出力。
 *
 * **この口が何であり、何でないか**は `runtime.ts` の `Runtime.applyCorrection` の doc
 * コメントを見ること——ここには型の形だけを置く。要約: [ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)
 * が「候補を返すところまで」に止めた `findCorrectionCandidates` の**続き**——採用側が
 * 候補から指名した相手（`correctedId`）を受け取り、`markContested`/`resolveContested`
 * （両方とも既存の口。ADR 0134/ADR 0150）を呼ぶだけの**薄い orchestration**である。
 *
 * ⛔ **この口も「相手を選ぶ」ことは一切しない。** `correctedId` は必ず呼び出し側が渡す
 * ——`discovery.candidates[0]` を自動的に採る経路は無い（`correctedId` が
 * `discovery.candidates` に居るかどうかの**照合**にしか候補を使わない）。ADR 0232 が
 * 実測した危険（B群: 訂正してはいけない8件中、棄権率 0/8・深い誤爆 6/8）への応答は
 * 「候補を機械的に採らない」という、この口が持たない振る舞いによって保たれる。
 */

/** `Runtime.applyCorrection` への入力。 */
export interface ApplyCorrectionInput {
  /**
   * `runtime.findCorrectionCandidates(ctx, { text, excludeMemoryIds })` の結果そのまま。
   * **この口自身は `recall()`/`findCorrectionCandidates` を呼ばない**——呼び出し側が
   * 先に呼んで渡す（`consolidate`/`reflect` の `{ seedMemoryId }` 形と同じく、この口の中で
   * 新しい探索を発明しない）。
   */
  discovery: FindCorrectionCandidatesResult;
  /**
   * 採用側が指名した、**訂正される側**（古いほう）の id。
   *
   * **省略できる。** `undefined` のまま呼ぶと、書き込みを1件も試みずに
   * `{ kind: "awaiting_choice" }` を返す——ADR 0232 の B群が示した危険（棄権しない）を、
   * この口の一段上（呼び出し側が指名しない、という選択）で可視化する経路そのもの。
   */
  correctedId?: MemoryId;
  /**
   * 訂正する側（新しい発話・新しい事実）の id。**常に必須**——この口は「訂正だ」という
   * 宣言そのものを表す発話の Memory を常に持っている前提で呼ばれる。
   */
  correctingId: MemoryId;
  /**
   * 「どちらが正しいか」。**省略すると `markContested` だけを呼んで `contested` で止まる**
   * ——`resolveContested` は一度も呼ばれない。渡せば、`markContested` に続けて
   * `resolveContested` まで呼ぶ。
   *
   * ⭐ **`markContested` した直後に `resolution` を渡さず、後から別の
   * `applyCorrection` 呼び出しで `resolution` を渡す、という2段の使い方もできる。**
   * 2回目の呼び出しでも `markContested` は呼ばれる（この口は「1回目で mark 済みかどうか」
   * を記憶しない、状態を持たない orchestration であるため）が、対象は既に
   * `status: 'contested'` なので {@link MarkContestedResult} は `ineligible` を返すだけで
   * 書き込みは起きない——`resolveContested` 側は正常に解決へ進む
   * （`examples/chat/src/correction-demo.ts` の `runCorrectionDemo` がこの2段呼び出しを
   * 実際に使い、`markContested` 直後の `recall()` で対（mandatory companion）を見せてから
   * `resolveContested` へ進む、という Issue #303 由来の実演を保っている）。
   */
  resolution?: ContestedResolution;
  /**
   * `markContested`/`resolveContested` の**両方**に、`opts.reason` としてそのまま渡す
   * （ADR 0238 決定2「同じ文字列を渡す」をこの口でも保つ）。
   *
   * ⛔ **この口は監査理由を自動生成しない。** 呼び出し側が {@link buildCorrectionReason}
   * を使って組み立てた文字列（または任意の自由文）をそのまま渡す——`applyCorrection`
   * 自身は `discovery`/`correctedId`/`correctingId`/`resolution` から「なぜ選んだか」を
   * 推測して書き込まない（推測させると、この口が実質的に「相手を選ぶ」判断を持つことに
   * 近づいてしまう。上の doc コメント参照）。
   */
  reason?: string;
  /** `markContested`/`resolveContested` の両方に渡す `memory_events.actor`。 */
  actor?: EventActor;
}

/**
 * `Runtime.applyCorrection` の結果（ADR 0008 の「無い」の分類の適用——「まだ選ばれていない」
 * 「候補に居ない」「対にしただけ」「対にして解決まで進めた」を1つの `boolean`/例外に潰さない）。
 *
 * - `"awaiting_choice"` — `correctedId` が渡されなかった。**書き込みは1件もしていない。**
 * - `"not_a_candidate"` — `correctedId` は渡されたが、`discovery.candidates` に居なかった。
 *   **書き込みは1件もしていない。**
 * - `"contested"` — `correctedId` は候補に居た。`markContested` を呼んだ
 *   （{@link MarkContestedResult} 自体が `contested`/`ineligible`/`conflict`/`not_attempted`
 *   のいずれかを持つ——`applyCorrection` はそれを握り潰さずそのまま運ぶ）。**`resolution` が
 *   渡されなかったので `resolveContested` は一度も呼んでいない。**
 * - `"resolved"` — `correctedId` は候補に居て、`resolution` も渡された。`markContested` に
 *   続けて `resolveContested` を呼んだ（{@link ResolveContestedResult} も同じく
 *   `resolved`/`ineligible`/`conflict`/`not_attempted` のいずれかをそのまま運ぶ）。
 *   ⚠ **`"resolved"` という kind 名は「`resolveContested` まで呼んだ」ことを意味するだけで、
 *   実際に解決が成功したことは意味しない**——成否は `resolveResult.outcome.kind` を見ること
 *   （`markContested`/`resolveContested` 自身の失敗（`ineligible`/`conflict`/`not_attempted`）
 *   を、この口が別の顔（例外・`false`）に変換しない、という契約）。
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

/**
 * `buildCorrectionReason`（[ADR 0238](../../../docs/decisions/0238-correction-choice-rationale-in-events.md)
 * が定めた形を `packages/core` へ持ち上げたもの、[ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)）
 * への入力。
 */
export interface CorrectionReasonInput {
  /** `applyCorrection` に渡すのと同じ `discovery`。`recallId`/`candidates.length` を運ぶ。 */
  discovery: FindCorrectionCandidatesResult;
  /**
   * 指名した候補の `CorrectionCandidate.recallRank`。呼び出し側が
   * `discovery.candidates.find((c) => c.memoryId === correctedId)?.recallRank` で引く
   * （{@link ApplyCorrectionResult} の `"contested"`/`"resolved"` 側も同じ値を運ぶ）。
   */
  chosenRecallRank: number;
  /** `ApplyCorrectionInput.correctedId` と同じ値。 */
  correctedId: MemoryId;
  /** `ApplyCorrectionInput.correctingId` と同じ値。 */
  correctingId: MemoryId;
  /**
   * どちらへ倒すか。**まだ決めていなければ `null`**——`resolution` を渡さずに
   * `markContested` だけを呼ぶ時点では、まだ勝者が無い。
   */
  resolution: ContestedResolution | null;
}

/**
 * 選んだ根拠（`recallId`・順位・候補の数・どちらへ倒したか）を、`memory_events.meta.note`
 * と `RecallResult.explain` の両方から辿れる形の1行にする
 * （Issue #369 チェックボックス、[ADR 0238](../../../docs/decisions/0238-correction-choice-rationale-in-events.md)）。
 *
 * 元は `examples/chat/src/correction-demo.ts` の非公開関数だった——[ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)
 * が `packages/core` の公開 export として持ち上げた。**形式（`key=value / ...` の1行、
 * 4要素、`score.total` は載せない）は ADR 0238 の決定を変えていない。** 変えたのは
 * `winner` の語彙だけ——ADR 0238 はデモの語彙（`original`/`correction`）を使っていたが、
 * `Runtime` レベルには「どちらが元の発話か」という概念が無く、持っているのは
 * `correctedId`（訂正される側）/`correctingId`（訂正する側）だけである。⟹ 汎用語彙
 * （`corrected`/`correcting`/`both_active`/`pending`）に置き換えた（下記 `winner` 参照）。
 *
 * `winner` の値:
 * - `resolution === null` → `"pending"`——`markContested` だけを呼ぶ時点ではまだ勝者が無い。
 * - `resolution.kind === "both_active"` → `"both_active"`——どちらも正しかった。
 * - `resolution.kind === "supersede"` → `winnerId === correctingId` なら `"correcting"`、
 *   そうでなければ `"corrected"`。
 *
 * ⚠ **`score.total` は載せない**（ADR 0238 決定1と同じ理由——スコアの閾値は ADR 0232 が
 * 実測した通り「訂正すべき」と「訂正してはいけない」を分離しない。生スコアを載せると
 * 「スコアが高かったから選ばれた」という誤った説明を後から読む側に与えてしまう）。
 * スコアの実際の値は `recallId` を辿って `RecallRecord.returnedMemories` から読む。
 */
export function buildCorrectionReason(input: CorrectionReasonInput): string {
  const winner: string =
    input.resolution === null
      ? "pending"
      : input.resolution.kind === "both_active"
        ? "both_active"
        : input.resolution.winnerId === input.correctingId
          ? "correcting"
          : "corrected";
  return (
    `chosenRecallRank=${input.chosenRecallRank} / candidates=${input.discovery.candidates.length} / ` +
    `recallId=${input.discovery.recallId} / winner=${winner}`
  );
}

/**
 * ⚠ **zod スキーマは置かない。** `correction-candidates.ts` 冒頭の同名の注記と同じ理由
 * ——`Runtime` の操作の結果型（`MarkContestedResult`/`ResolveContestedResult` 等）には
 * もともと schema が無く、`ApplyCorrectionResult` もそれらを運ぶだけの薄い orchestration
 * の結果であるため揃えた。検証する相手が居ないまま schema だけ足さない
 * （ADR 0181 / `__tests__/schema-type-equals-parity.test.ts`）。
 */
