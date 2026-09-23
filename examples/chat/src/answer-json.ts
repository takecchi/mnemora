import type { AnswerCaseRunResult } from "./answer-bench.js";
import type { AnswerCategory, AnswerVerdict } from "./answer-case.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { AnswerJudgement } from "./answer-judge.js";
import type { ProviderMode } from "./providers.js";

/**
 * `answer` の機械可読な出力口（`MNEMORA_ANSWER_JSON`、`cli.ts`）。
 *
 * `compare-json.ts`/`retrieval-json.ts` と同じ分担: ファイル I/O・環境変数・時刻取得を
 * 一切行わない純関数だけを置く。
 *
 * 🔴 **この JSON は回答品質を主張しない。** `qualityClaimable` が `false`
 * （`llmMode === "deterministic"`）のときは `summary`（何件中何件 pass の集計）を
 * 一切出さない——`answerQualityClaimable`（`answer-case.ts`）が唯一の判定源である。
 * ケースごとの `verdict` フィールド自体は raw データとして残す（機械可読な出力は
 * 後から品質を主張してよい層で読み直すことができる形にしておく）——ただし
 * **集計しない**という制約は変えない。
 */

/** {@link AnswerJudgement} をそのまま JSON へ写した形。 */
export type AnswerJudgementJson = AnswerJudgement;

export interface AnswerPathJson {
  inputChars: number;
  inputEstimatedTokens: number;
  answer: string;
  verdict: AnswerVerdict;
  /** 二次観測（judge）。judge が走っていない run では出さない。 */
  judgement?: AnswerJudgementJson;
  /** 一次判定と二次観測を突き合わせた結果。`judgement` が無ければこちらも無い。 */
  reconciled?: AnswerVerdict;
}

export interface AnswerCaseCostJson {
  extractionLLMCalls: number;
  embeddingCalls: number;
  answerLLMCalls: number;
  judgeLLMCalls: number;
}

export interface AnswerCaseJson {
  id: string;
  category: AnswerCategory;
  tuningUse: "development" | "held-out";
  naive: AnswerPathJson;
  mnemora: AnswerPathJson;
  cost: AnswerCaseCostJson;
}

export interface AnswerVerdictCountsJson {
  pass: number;
  fail: number;
  indeterminate: number;
}

/**
 * ⚠ **既存の一次判定の集計（`naive`/`mnemora`）はそのまま残す。** 追加するのは
 * 二次観測（judge の `outcome`）の集計 `judgement` と、突き合わせ後（`reconciled`）の
 * 集計 `reconciled` の2つの新しいブロックであり、既存の2欄の意味・形は変えていない。
 */
export interface AnswerSummaryJson {
  naive: AnswerVerdictCountsJson;
  mnemora: AnswerVerdictCountsJson;
  /** 二次観測（judge の `outcome`）の集計。一次判定を上書きしない、別欄。 */
  judgement: {
    naive: AnswerVerdictCountsJson;
    mnemora: AnswerVerdictCountsJson;
  };
  /** 一次判定と二次観測を突き合わせた（`reconcileVerdicts`）後の集計。 */
  reconciled: {
    naive: AnswerVerdictCountsJson;
    mnemora: AnswerVerdictCountsJson;
  };
}

/**
 * 入力量の削減率。**`summary` とは別枠であり、`qualityClaimable` に関係なく常に出す**
 * ——入力量そのものは品質の主張ではない（回答が正しいかどうかと無関係に測れる）。
 * ⛔ judge の追加呼び出し費用は差し引かない（`AnswerCaseCost.judgeLLMCalls` は
 * 別の「追加費用」ブロックの管轄——`answer-format.ts` の `formatAnswerCostTable`）。
 */
export interface AnswerInputReductionJson {
  naiveInputChars: number;
  mnemoraInputChars: number;
  /** `(naiveInputChars - mnemoraInputChars) / naiveInputChars`。`naiveInputChars` が0なら0。 */
  charReductionRatio: number;
  naiveInputEstimatedTokens: number;
  mnemoraInputEstimatedTokens: number;
  /** `(naiveInputEstimatedTokens - mnemoraInputEstimatedTokens) / naiveInputEstimatedTokens`。 */
  tokenReductionRatio: number;
}

export interface AnswerRunJson {
  /** この形が変わったら上げる。二次観測・突き合わせ・`inputReduction` を足して 1→2。 */
  schemaVersion: 2;
  measuredAt: string;
  commit: string | null;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `answerQualityClaimable(llmMode)` の結果。`false` なら `summary` は無い。 */
  qualityClaimable: boolean;
  caseCount: number;
  cases: AnswerCaseJson[];
  /** `qualityClaimable === true` のときだけ存在する。 */
  summary?: AnswerSummaryJson;
  /** `qualityClaimable` に関係なく常に存在する（上記 docstring）。 */
  inputReduction: AnswerInputReductionJson;
}

export interface BuildAnswerJsonOptions {
  results: readonly AnswerCaseRunResult[];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  measuredAt: Date;
  commit: string | null;
}

function emptyVerdictCounts(): AnswerVerdictCountsJson {
  return { pass: 0, fail: 0, indeterminate: 0 };
}

function tallyVerdicts(verdicts: readonly AnswerVerdict[]): AnswerVerdictCountsJson {
  const counts = emptyVerdictCounts();
  for (const v of verdicts) {
    counts[v] += 1;
  }
  return counts;
}

/** `AnswerJudgement.outcome` の集合は `AnswerVerdict` と同じ3値なので `tallyVerdicts` を使い回せる。 */
function tallyJudgementOutcomes(
  judgements: readonly (AnswerJudgement | undefined)[],
): AnswerVerdictCountsJson {
  return tallyVerdicts(
    judgements.filter((j): j is AnswerJudgement => j !== undefined).map((j) => j.outcome),
  );
}

function tallyReconciled(values: readonly (AnswerVerdict | undefined)[]): AnswerVerdictCountsJson {
  return tallyVerdicts(values.filter((v): v is AnswerVerdict => v !== undefined));
}

/**
 * 入力量の削減率を計算する純関数。`answer-format.ts` の表示側も同じ計算をこの関数に
 * 委ねる（二重に計算式を持たない）。
 */
export function computeInputReduction(
  results: readonly AnswerCaseRunResult[],
): AnswerInputReductionJson {
  const naiveInputChars = results.reduce((sum, r) => sum + r.naive.inputChars, 0);
  const mnemoraInputChars = results.reduce((sum, r) => sum + r.mnemora.inputChars, 0);
  const naiveInputEstimatedTokens = results.reduce(
    (sum, r) => sum + r.naive.inputEstimatedTokens,
    0,
  );
  const mnemoraInputEstimatedTokens = results.reduce(
    (sum, r) => sum + r.mnemora.inputEstimatedTokens,
    0,
  );
  return {
    naiveInputChars,
    mnemoraInputChars,
    charReductionRatio:
      naiveInputChars === 0 ? 0 : (naiveInputChars - mnemoraInputChars) / naiveInputChars,
    naiveInputEstimatedTokens,
    mnemoraInputEstimatedTokens,
    tokenReductionRatio:
      naiveInputEstimatedTokens === 0
        ? 0
        : (naiveInputEstimatedTokens - mnemoraInputEstimatedTokens) / naiveInputEstimatedTokens,
  };
}

function buildPathJson(path: {
  inputChars: number;
  inputEstimatedTokens: number;
  answer: string;
  verdict: AnswerVerdict;
  judgement?: AnswerJudgement;
  reconciled?: AnswerVerdict;
}): AnswerPathJson {
  return {
    inputChars: path.inputChars,
    inputEstimatedTokens: path.inputEstimatedTokens,
    answer: path.answer,
    verdict: path.verdict,
    ...(path.judgement !== undefined ? { judgement: path.judgement } : {}),
    ...(path.reconciled !== undefined ? { reconciled: path.reconciled } : {}),
  };
}

export function buildAnswerJson(options: BuildAnswerJsonOptions): AnswerRunJson {
  const qualityClaimable = answerQualityClaimable(options.llmMode);
  const cases: AnswerCaseJson[] = options.results.map((result) => ({
    id: result.case.id,
    category: result.case.category,
    tuningUse: result.case.tuningUse,
    naive: buildPathJson(result.naive),
    mnemora: buildPathJson(result.mnemora),
    cost: { ...result.cost },
  }));

  return {
    schemaVersion: 2,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    qualityClaimable,
    caseCount: cases.length,
    cases,
    ...(qualityClaimable
      ? {
          summary: {
            naive: tallyVerdicts(options.results.map((r) => r.naive.verdict)),
            mnemora: tallyVerdicts(options.results.map((r) => r.mnemora.verdict)),
            judgement: {
              naive: tallyJudgementOutcomes(options.results.map((r) => r.naive.judgement)),
              mnemora: tallyJudgementOutcomes(options.results.map((r) => r.mnemora.judgement)),
            },
            reconciled: {
              naive: tallyReconciled(options.results.map((r) => r.naive.reconciled)),
              mnemora: tallyReconciled(options.results.map((r) => r.mnemora.reconciled)),
            },
          },
        }
      : {}),
    inputReduction: computeInputReduction(options.results),
  };
}
