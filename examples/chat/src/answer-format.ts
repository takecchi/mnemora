import type { AnswerCaseRunResult } from "./answer-bench.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { AnswerVerdict } from "./answer-case.js";
import { computeInputReduction } from "./answer-json.js";
import type { ProviderMode } from "./providers.js";

/**
 * `answer` の人間向け出力（Markdown 表 + 目立つ注記）。
 *
 * 🔴 **`answerQualityClaimable(llmMode) === false` のとき、正誤の列に判定を出さない。**
 * `—` を出し、脚注で理由を書く——`llmMode=deterministic` は意味を持たない stub であり、
 * この bench が回っても回答品質は測っていない。
 */

/** stdout の先頭に出す、目立つ注記。`llmMode` が `deterministic` のときだけ非空を返す。 */
export function formatAnswerQualityBanner(llmMode: ProviderMode): string {
  if (answerQualityClaimable(llmMode)) {
    return "";
  }
  return (
    "⛔⛔⛔ これは配線の検査であり、回答品質は測っていない（llmMode=deterministic） ⛔⛔⛔\n" +
    "deterministic の LLM は意味を持たない stub（渡された最後のメッセージをそのまま返す）である。" +
    "以下の表・JSON は naive/mnemora が同じ入力量・同じ呼び出し方で走ることの配線検査であって、" +
    "どちらの回答が正しいかは、この run からは何も言えない。"
  );
}

function verdictGlyph(verdict: AnswerVerdict): string {
  switch (verdict) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "indeterminate":
      return "❓";
    default: {
      const exhaustive: never = verdict;
      throw new Error(`verdictGlyph: 未知の AnswerVerdict: ${String(exhaustive)}`);
    }
  }
}

/** 二次観測・突き合わせの列も `verdictGlyph` を使い回す——`AnswerJudgeOutcome` は
 * `AnswerVerdict` と同じ3値（"pass"/"fail"/"indeterminate"）である。 */
function glyphOrDash(claimable: boolean, value: AnswerVerdict | undefined): string {
  if (!claimable || value === undefined) {
    return "—";
  }
  return verdictGlyph(value);
}

/**
 * ケースごとの入力量（naive/mnemora）と、質を主張できるときだけの正誤・二次観測・
 * 突き合わせを並べた表。
 *
 * `answerQualityClaimable(llmMode) === false` のときは正誤・二次観測・突き合わせの
 * **すべての列**に `—` を出し、表の下に脚注を足す。
 */
export function formatAnswerTable(
  results: readonly AnswerCaseRunResult[],
  llmMode: ProviderMode,
): string {
  const claimable = answerQualityClaimable(llmMode);
  const header =
    "| id | category | tuningUse | naive chars | naive tokens(概算) | mnemora chars | " +
    "mnemora tokens(概算) | naive 正誤 | mnemora 正誤 | naive 二次観測 | mnemora 二次観測 | " +
    "naive 突き合わせ | mnemora 突き合わせ |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = results.map((r) => {
    const naiveVerdict = glyphOrDash(claimable, r.naive.verdict);
    const mnemoraVerdict = glyphOrDash(claimable, r.mnemora.verdict);
    const naiveJudgement = glyphOrDash(claimable, r.naive.judgement?.outcome);
    const mnemoraJudgement = glyphOrDash(claimable, r.mnemora.judgement?.outcome);
    const naiveReconciled = glyphOrDash(claimable, r.naive.reconciled);
    const mnemoraReconciled = glyphOrDash(claimable, r.mnemora.reconciled);
    return (
      `| ${r.case.id} | ${r.case.category} | ${r.case.tuningUse} | ${r.naive.inputChars} | ` +
      `${r.naive.inputEstimatedTokens} | ${r.mnemora.inputChars} | ` +
      `${r.mnemora.inputEstimatedTokens} | ${naiveVerdict} | ${mnemoraVerdict} | ` +
      `${naiveJudgement} | ${mnemoraJudgement} | ${naiveReconciled} | ${mnemoraReconciled} |`
    );
  });
  const lines = [header, sep, ...body];
  lines.push(
    "",
    "(注) 二次観測は LLM 採点であり、一次判定を上書きしない。食い違いは indeterminate" +
      "（`reconcileVerdicts`、`answer-judge.ts`）。",
  );
  if (!claimable) {
    lines.push(
      "(注) 正誤・二次観測・突き合わせの列は `—`——`llmMode=deterministic` では" +
        "回答品質を主張できない（`answerQualityClaimable`、`answer-case.ts`）。",
    );
  }
  return lines.join("\n");
}

/**
 * 追加費用（別ブロック）。⛔ 削減率から差し引かない——ここに独立して出す。
 */
export function formatAnswerCostTable(results: readonly AnswerCaseRunResult[]): string {
  const header =
    "| id | 抽出 LLM 呼び出し | 埋め込み呼び出し | 回答生成 LLM 呼び出し | judge LLM 呼び出し |";
  const sep = "|---|---|---|---|---|";
  const body = results.map(
    (r) =>
      `| ${r.case.id} | ${r.cost.extractionLLMCalls} | ${r.cost.embeddingCalls} | ` +
      `${r.cost.answerLLMCalls} | ${r.cost.judgeLLMCalls} |`,
  );
  const totalExtraction = results.reduce((sum, r) => sum + r.cost.extractionLLMCalls, 0);
  const totalEmbedding = results.reduce((sum, r) => sum + r.cost.embeddingCalls, 0);
  const totalAnswer = results.reduce((sum, r) => sum + r.cost.answerLLMCalls, 0);
  const totalJudge = results.reduce((sum, r) => sum + r.cost.judgeLLMCalls, 0);
  const totalRow =
    `| **合計** | **${totalExtraction}** | **${totalEmbedding}** | **${totalAnswer}** | ` +
    `**${totalJudge}** |`;
  return [header, sep, ...body, totalRow].join("\n");
}

/**
 * 入力量の削減率を1行で出す。**`qualityClaimable` に関係なく常に出す**
 * ——入力量は品質の主張ではない（`answer-json.ts` の `AnswerInputReductionJson`
 * docstring 参照）。計算は `computeInputReduction`（`answer-json.ts`）に委ね、
 * ここでは表示用の書式だけを持つ。
 */
export function formatAnswerInputReduction(results: readonly AnswerCaseRunResult[]): string {
  const r = computeInputReduction(results);
  const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;
  return (
    "入力量の削減率（naive→mnemora。⛔ judge 等の追加呼び出し費用は差し引いていない）: " +
    `chars ${pct(r.charReductionRatio)}（合計 ${r.naiveInputChars} → ${r.mnemoraInputChars}） / ` +
    `tokens(概算) ${pct(r.tokenReductionRatio)}` +
    `（合計 ${r.naiveInputEstimatedTokens} → ${r.mnemoraInputEstimatedTokens}）`
  );
}
