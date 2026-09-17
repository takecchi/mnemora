import type { Ctx, LLMProvider, PromptSpec } from "@mnemora/core";
import type { AnswerExpectation, AnswerVerdict } from "./answer-case.js";

/**
 * 二次観測（LLM 採点）。Issue #506 の未達1件（親 #498）。
 *
 * **一次判定（`gradeAnswer`、`answer-case.ts`）は機械であり、LLM を呼ばない。** ここで
 * 足すのはそれとは別の、独立した観測——同じ回答を LLM 自身にも採点させ、一次と突き合わせる。
 *
 * 🔴 **設計上の必須事項（外さない）:**
 *
 * 1. **`completeStructured` を使わない。`complete()`（素のテキスト）＋厳格パースにする。**
 *    `DeterministicLLMProvider.completeStructured` は未対応スキーマで例外を投げる
 *    （`packages/testkit/src/__fixtures__/deterministic-llm-provider.ts`）。judge が
 *    structured を使うと、deterministic での空撃ちと既存の配線検査が落ちる。`complete()`
 *    なら deterministic では stub がプロンプトをエコーし、パースに失敗して
 *    `indeterminate` になる——これが正しい退避である。
 * 2. **パースできない応答は必ず `indeterminate`。** 既定値で `pass`/`fail` へ倒さない。
 * 3. **judge に `expected.accept`/`expected.reject` を渡さない。** 渡すと一次判定の写しに
 *    なり、独立した観測でなくなる（Issue #498「LLM採点だけを無条件の正解にしない」/
 *    `docs/autonomy.md` §2.2 決定5「別の AI が採点したという理由だけで、正解の根拠や
 *    独立性が確保されたと見なさない」）。渡してよいのは、質問文・`expected.kind`・
 *    `grounds.rationale`・`grounds.turnIndex` で引いた会話ターンの本文・採点対象の回答文
 *    だけ——{@link AnswerJudgeInput} の形がそれを型で表す（`accept`/`reject` を持たない）。
 * 4. **一次判定を上書きしない。** {@link AnswerJudgement} は別欄であり、
 *    {@link reconcileVerdicts} が一致すれば一次を、食い違えば `"indeterminate"` を返す
 *    （ADR 0222 の三分割に倣う）。
 * 5. **呼び出し回数は `AnswerCaseCost.judgeLLMCalls`（`answer-bench.ts`）に数える。**
 *    削減率（入力量の比較）からは差し引かない——追加費用の表に別列として出す。
 * 6. **プロンプトは naive/mnemora の両経路で同一の書式にする。** 採点基準を経路で変えない。
 */

export type AnswerJudgeOutcome = "pass" | "fail" | "indeterminate";

export interface AnswerJudgement {
  /** 二次観測そのもの。⛔ 一次判定を上書きしない。 */
  outcome: AnswerJudgeOutcome;
  /** LLM が書いた理由（生の応答から取れたときだけ）。取れなければ空文字。 */
  reason: string;
  /** 生の応答（先頭のみ、診断用）。パースできなかったときに特に意味を持つ。 */
  raw: string;
}

/** {@link raw} を診断に足りるだけ残しつつ、無限に長い応答を貼らないための上限。 */
const RAW_HEAD_LENGTH = 500;

/**
 * judge に渡してよい入力だけを持つ形。**`AnswerExpectation.accept`/`reject` を持たない**
 * ——構造的に持てないことで、設計上の必須事項3を型で強制する。
 */
export interface AnswerJudgeInput {
  question: string;
  expectedKind: AnswerExpectation["kind"];
  /** 正解の根拠（`grounds.rationale`）。実装の挙動の説明ではなく、会話の文面に対する説明。 */
  rationale: string;
  /** `grounds.turnIndex` で引いた会話ターンの本文。`unknown` 類では空配列になりうる。 */
  groundTurnTexts: string[];
  /** 採点対象の回答文（naive/mnemora のどちらか一方）。 */
  answer: string;
}

export const ANSWER_JUDGE_SYSTEM_PROMPT =
  "あなたは回答の採点者です。与えられた質問・正解の根拠・会話の抜粋・採点対象の回答を読み、" +
  "回答が正しいかを判定してください。\n" +
  "出力は必ず次の2行だけにしてください。他の文章を前後に足さないでください。\n" +
  "判定: PASS または FAIL または INDETERMINATE\n" +
  "理由: <30字程度の短い説明>\n" +
  "質問の種別が closed-value のときは、回答が根拠と整合する具体的な答えを言えていれば PASS、" +
  "誤った値を言っていれば FAIL としてください。質問の種別が must-abstain のときは、回答が" +
  "『分からない』のように答えを保留していれば PASS、何らかの具体的な値を断定していれば FAIL " +
  "としてください。根拠だけからは判定できない場合は INDETERMINATE としてください。";

/** `groundTurnTexts` を箇条書きにする。空配列なら「根拠となる発言なし」と明示する。 */
function formatGroundTurns(groundTurnTexts: readonly string[]): string {
  if (groundTurnTexts.length === 0) {
    return "(根拠となる発言なし)";
  }
  return groundTurnTexts.map((text) => `- ${text}`).join("\n");
}

/**
 * judge へ渡す `PromptSpec` を組み立てる。**naive/mnemora で同一の書式**（設計上の
 * 必須事項6）——この関数自体がどちらの経路の回答かを知らない。
 *
 * ⛔ **`AnswerJudgeInput` に `accept`/`reject` が無いため、ここでそれらを埋め込むことが
 * 構造的にできない**（設計上の必須事項3の機械的な担保）。
 */
export function buildAnswerJudgePromptSpec(input: AnswerJudgeInput): PromptSpec {
  const kindLabel =
    input.expectedKind === "closed-value"
      ? "closed-value（答えが一意に閉じる質問）"
      : "must-abstain（『分からない』と答えるべき質問）";
  const user = [
    `質問の種別: ${kindLabel}`,
    `質問: ${input.question}`,
    `正解の根拠（要約）: ${input.rationale}`,
    `根拠となる会話の抜粋:\n${formatGroundTurns(input.groundTurnTexts)}`,
    `採点対象の回答: ${input.answer}`,
  ].join("\n\n");
  return {
    system: ANSWER_JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
  };
}

const VERDICT_LINE_RE = /^\s*判定\s*[:：]\s*(pass|fail|indeterminate)\b/imu;
const REASON_LINE_RE = /^\s*理由\s*[:：]\s*(.*)$/imu;

/**
 * judge の応答を厳格にパースする。**パースできなければ必ず `indeterminate`**
 * （設計上の必須事項2）——`pass`/`fail` へ既定で倒さない。
 *
 * 「パースできない」の実例:
 * - `判定:` 行が無い（deterministic stub がプロンプト全文をエコーした場合を含む）
 * - `判定:` の値が `PASS`/`FAIL`/`INDETERMINATE` のいずれでもない
 * - 空文字・JSON・記号列など、およそ想定していない形
 */
export function parseAnswerJudgeResponse(raw: string): AnswerJudgement {
  const rawHead = raw.length > RAW_HEAD_LENGTH ? `${raw.slice(0, RAW_HEAD_LENGTH)}…` : raw;
  const verdictMatch = VERDICT_LINE_RE.exec(raw);
  if (!verdictMatch) {
    return { outcome: "indeterminate", reason: "", raw: rawHead };
  }
  const outcome = verdictMatch[1]!.toLowerCase() as AnswerJudgeOutcome;
  const reasonMatch = REASON_LINE_RE.exec(raw);
  const reason = reasonMatch ? reasonMatch[1]!.trim() : "";
  return { outcome, reason, raw: rawHead };
}

/**
 * 1件、judge を呼んで結果をパースする。`llmProvider.complete()` だけを使う
 * （設計上の必須事項1）。
 */
export async function judgeAnswer(
  llmProvider: LLMProvider,
  ctx: Ctx,
  input: AnswerJudgeInput,
): Promise<AnswerJudgement> {
  const promptSpec = buildAnswerJudgePromptSpec(input);
  const response = await llmProvider.complete(ctx, promptSpec);
  return parseAnswerJudgeResponse(response.content);
}

/**
 * 一次判定（`gradeAnswer`）と二次観測（judge）を突き合わせる。
 *
 * ⭐ **食い違いは `indeterminate`**（ADR 0222 の三分割）。⛔ 一致しないからといって
 * どちらか一方を勝たせない——「独立した2つの観測が一致した」ときだけ、その値を信じる。
 *
 * ⛔ **secondary が無いときに黙って primary を返す経路をこの関数の外に作らない**
 * ——judge が走っていない run では、呼び出し側が `reconciled` 自体を出力しないこと
 * （`AnswerPathMeasurement.reconciled` はオプショナル）。
 */
export function reconcileVerdicts(
  primary: AnswerVerdict,
  secondary: AnswerJudgeOutcome,
): AnswerVerdict {
  return (primary as string) === (secondary as string) ? primary : "indeterminate";
}
