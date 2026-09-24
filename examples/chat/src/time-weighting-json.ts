import type { TimeWeightingPolicy } from "@mnemora/core";
import type {
  TimeWeightingAggregateCell,
  TimeWeightingTrialResult,
} from "./time-weighting-bench.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { AnswerVerdict } from "./answer-case.js";
import type { TimeWeightingCaseKind } from "./time-weighting-case.js";
import type { ProviderMode } from "./providers.js";

/**
 * `answer-time-weighting` の機械可読な出力口（`MNEMORA_TIME_WEIGHTING_JSON`、`cli.ts`）。
 * `answer-json.ts` と同じ分担: 純関数のみ、ファイル I/O は呼び出し側（`cli.ts`）が行う。
 */

export interface TimeWeightingTrialJson {
  caseId: string;
  kind: TimeWeightingCaseKind;
  trial: number;
  policy: TimeWeightingPolicy;
  verdict: AnswerVerdict;
  recallMemoryCount: number;
  inputChars: number;
  inputEstimatedTokens: number;
}

export interface TimeWeightingAggregateJson {
  caseId: string;
  kind: TimeWeightingCaseKind;
  policy: TimeWeightingPolicy;
  trials: number;
  passCount: number;
}

export interface TimeWeightingRunJson {
  measuredAt: string;
  commit: string | null;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  qualityClaimable: boolean;
  trials: TimeWeightingTrialJson[];
  /** `qualityClaimable === false` のときは出さない（`answer-json.ts` の `summary` と同じ規律）。 */
  aggregate?: TimeWeightingAggregateJson[];
}

export interface BuildTimeWeightingJsonOptions {
  results: readonly TimeWeightingTrialResult[];
  aggregate: readonly TimeWeightingAggregateCell[];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  measuredAt: Date;
  commit: string | null;
}

export function buildTimeWeightingJson(opts: BuildTimeWeightingJsonOptions): TimeWeightingRunJson {
  const qualityClaimable = answerQualityClaimable(opts.llmMode);
  const trials: TimeWeightingTrialJson[] = [];
  for (const result of opts.results) {
    for (const policy of Object.keys(result.byPolicy) as TimeWeightingPolicy[]) {
      const p = result.byPolicy[policy];
      trials.push({
        caseId: result.case.id,
        kind: result.case.kind,
        trial: result.trial,
        policy,
        verdict: p.verdict,
        recallMemoryCount: p.recallMemoryCount,
        inputChars: p.inputChars,
        inputEstimatedTokens: p.inputEstimatedTokens,
      });
    }
  }
  return {
    measuredAt: opts.measuredAt.toISOString(),
    commit: opts.commit,
    llmMode: opts.llmMode,
    embeddingMode: opts.embeddingMode,
    qualityClaimable,
    trials,
    ...(qualityClaimable
      ? {
          aggregate: opts.aggregate.map((cell) => ({
            caseId: cell.caseId,
            kind: cell.kind,
            policy: cell.policy,
            trials: cell.trials,
            passCount: cell.passCount,
          })),
        }
      : {}),
  };
}
