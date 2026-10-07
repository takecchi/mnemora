import type { Ctx, LLMProvider, PromptSpec } from "@mnemora/core";
import type { AnswerExpectation, AnswerVerdict } from "./answer-case.js";

/**
 * 二次観測（LLM 採点）。一次判定 `gradeAnswer` とは独立に、同じ回答を LLM にも採点させて突き合わせる。
 *
 * - `completeStructured` を使わず、`complete()` ＋厳格パースにする。deterministic の `completeStructured` は
 *   未対応スキーマで例外を投げ、空撃ちと既存の配線検査が落ちる。
 * - パースできない応答は必ず `indeterminate` にし、既定で `pass`/`fail` へ倒さない。
 * - judge に `expected.accept`/`reject` を渡さない。渡すと一次判定の写しになり、独立した観測でなくなる。
 * - プロンプトは naive/mnemora で同一の書式にし、採点基準を経路で変えない。
 */

export type AnswerJudgeOutcome = "pass" | "fail" | "indeterminate";

export interface AnswerJudgement {
  outcome: AnswerJudgeOutcome;
  reason: string;
  raw: string;
}

const RAW_HEAD_LENGTH = 500;

export interface AnswerJudgeInput {
  question: string;
  expectedKind: AnswerExpectation["kind"];
  rationale: string;
  groundTurnTexts: string[];
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

function formatGroundTurns(groundTurnTexts: readonly string[]): string {
  if (groundTurnTexts.length === 0) {
    return "(根拠となる発言なし)";
  }
  return groundTurnTexts.map((text) => `- ${text}`).join("\n");
}

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
 * 一次判定と二次観測を突き合わせる。食い違いは `indeterminate` にし、どちらか一方を勝たせない。
 * secondary が無いときに黙って primary を返す経路をこの関数の外に作らない（judge が走っていない run では `reconciled` 自体を出力しない）。
 */
export function reconcileVerdicts(
  primary: AnswerVerdict,
  secondary: AnswerJudgeOutcome,
): AnswerVerdict {
  return (primary as string) === (secondary as string) ? primary : "indeterminate";
}
