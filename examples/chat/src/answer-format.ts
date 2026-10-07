import type { AnswerCaseRunResult } from "./answer-bench.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { AnswerVerdict } from "./answer-case.js";
import { computeInputReduction } from "./answer-json.js";
import type { ProviderMode } from "./providers.js";

/** `answerQualityClaimable(llmMode) === false` のとき、正誤の列に判定を出さず `—` と脚注にする。deterministic の実行は品質を測っていないため。 */

export function formatAnswerIntro(llmMode: ProviderMode): string {
  const lead =
    "\n同じ会話・同じ質問・同じ回答モデル・同じ採点基準で、naive(全文経路)と" +
    "mnemora(記憶経路)の最終回答・入力量を対で出す(Issue #506)。\n";
  if (!answerQualityClaimable(llmMode)) {
    return `${lead}🔴 これは配線の検査であり、回答品質は測っていない（llmMode=${llmMode}）。\n`;
  }
  const source = llmMode === "recorded" ? "記録した時点の実 API の回答の再生" : "実 API の回答";
  return (
    `${lead}正誤・二次観測は、回答モデルの実際の回答（llmMode=${llmMode}: ${source}）に対する判定である。` +
    "このケース集合に対する判定であり、一般的な回答品質の保証ではない。\n"
  );
}

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

function glyphOrDash(claimable: boolean, value: AnswerVerdict | undefined): string {
  if (!claimable || value === undefined) {
    return "—";
  }
  return verdictGlyph(value);
}

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

/** 追加費用は別ブロック。削減率から差し引かず、独立して出す。 */
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

export function formatAnswerContentPreservation(results: readonly AnswerCaseRunResult[]): string {
  const tally = (pick: (r: AnswerCaseRunResult) => { applicable: boolean; preserved: boolean }) => {
    const values = results.map(pick).filter((v) => v.applicable);
    return { applicable: values.length, preserved: values.filter((v) => v.preserved).length };
  };
  const naive = tally((r) => r.naive.contentPreservation);
  const mnemora = tally((r) => r.mnemora.contentPreservation);
  return (
    "層2(回答に必要な情報の保持。LLM を呼ばない決定的な指標。⛔ 最終回答の正誤とは別欄): " +
    `naive ${naive.preserved}/${naive.applicable} 件 / mnemora ${mnemora.preserved}/${mnemora.applicable} 件` +
    `（分母は must-abstain 類を除いた ${naive.applicable} 件）`
  );
}

/**
 * 入力量の削減率を1行で出す。見出しに差の向きを書き、値にも言葉を添える。
 * 「削減率 -26.3%」とだけ出すと、mnemora のほうが多いのに「26%削った」と読み違えるため。
 */
export function formatAnswerInputReduction(results: readonly AnswerCaseRunResult[]): string {
  const r = computeInputReduction(results);
  const describe = (naive: number, mnemora: number, reductionRatio: number): string => {
    const diff = mnemora - naive;
    const signedDiff = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : "±0";
    const pct = `${(Math.abs(reductionRatio) * 100).toFixed(1)}%`;
    const words =
      diff > 0 ? `mnemora が ${pct} 多い` : diff < 0 ? `mnemora が ${pct} 少ない` : "同じ";
    return `${naive} → ${mnemora}（${signedDiff}、${words}）`;
  };
  return (
    "入力量の mnemora − 全文の差（負なら mnemora が少ない。⛔ judge 等の追加呼び出し費用は含めていない）: " +
    `chars ${describe(r.naiveInputChars, r.mnemoraInputChars, r.charReductionRatio)} / ` +
    `tokens(概算) ${describe(r.naiveInputEstimatedTokens, r.mnemoraInputEstimatedTokens, r.tokenReductionRatio)}`
  );
}
