import type { AnswerCaseRunResult } from "./answer-bench.js";
import type { AnswerCategory, AnswerVerdict } from "./answer-case.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { ContentPreservationResult } from "./answer-content-preservation.js";
import type { AnswerJudgement } from "./answer-judge.js";
import type { ProviderMode } from "./providers.js";

/**
 * `answer` の機械可読な出力口。ファイル I/O・環境変数・時刻取得を行わない純関数だけを置く。
 *
 * `qualityClaimable` が `false` のときは `summary`（pass の集計）を出さない。ケースごとの `verdict` は raw データとして残すが、集計はしない。
 */

export type AnswerJudgementJson = AnswerJudgement;

export interface AnswerPathJson {
  inputChars: number;
  inputEstimatedTokens: number;
  answer: string;
  verdict: AnswerVerdict;
  judgement?: AnswerJudgementJson;
  reconciled?: AnswerVerdict;
  contentPreservation: ContentPreservationResult;
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

export interface AnswerSummaryJson {
  naive: AnswerVerdictCountsJson;
  mnemora: AnswerVerdictCountsJson;
  judgement: {
    naive: AnswerVerdictCountsJson;
    mnemora: AnswerVerdictCountsJson;
  };
  reconciled: {
    naive: AnswerVerdictCountsJson;
    mnemora: AnswerVerdictCountsJson;
  };
}

export interface AnswerContentPreservationCountsJson {
  applicable: number;
  preserved: number;
}

/** 入力量の削減率。`summary` とは別枠で、`qualityClaimable` に関係なく常に出す。judge の追加呼び出し費用は差し引かない。 */
export interface AnswerInputReductionJson {
  naiveInputChars: number;
  mnemoraInputChars: number;
  charReductionRatio: number;
  naiveInputEstimatedTokens: number;
  mnemoraInputEstimatedTokens: number;
  tokenReductionRatio: number;
}

export interface AnswerRunJson {
  schemaVersion: 3;
  measuredAt: string;
  commit: string | null;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  qualityClaimable: boolean;
  caseCount: number;
  cases: AnswerCaseJson[];
  summary?: AnswerSummaryJson;
  inputReduction: AnswerInputReductionJson;
  contentPreservation: {
    naive: AnswerContentPreservationCountsJson;
    mnemora: AnswerContentPreservationCountsJson;
  };
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

function tallyContentPreservation(
  results: readonly ContentPreservationResult[],
): AnswerContentPreservationCountsJson {
  const applicable = results.filter((r) => r.applicable);
  return {
    applicable: applicable.length,
    preserved: applicable.filter((r) => r.preserved).length,
  };
}

function buildPathJson(path: {
  inputChars: number;
  inputEstimatedTokens: number;
  answer: string;
  verdict: AnswerVerdict;
  judgement?: AnswerJudgement;
  reconciled?: AnswerVerdict;
  contentPreservation: ContentPreservationResult;
}): AnswerPathJson {
  return {
    inputChars: path.inputChars,
    inputEstimatedTokens: path.inputEstimatedTokens,
    answer: path.answer,
    verdict: path.verdict,
    ...(path.judgement !== undefined ? { judgement: path.judgement } : {}),
    ...(path.reconciled !== undefined ? { reconciled: path.reconciled } : {}),
    contentPreservation: path.contentPreservation,
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
    schemaVersion: 3,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    qualityClaimable,
    caseCount: cases.length,
    cases,
    contentPreservation: {
      naive: tallyContentPreservation(options.results.map((r) => r.naive.contentPreservation)),
      mnemora: tallyContentPreservation(options.results.map((r) => r.mnemora.contentPreservation)),
    },
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
