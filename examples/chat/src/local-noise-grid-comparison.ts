import type { CapturedProbeCandidates } from "./synthetic-score-noise.js";
import { computeNoisyGroupMetrics, decideNoiseRoundRed } from "./synthetic-score-noise.js";

/**
 * σ 格子 × seed 全通りを再計算し、sparse/dense の結果を数値として突き合わせる。`local-noise-candidate-diff.ts` は入力の同一性だけを見るが、
 * こちらは出力（MRR 実値・red/green）まで突き合わせる。
 *
 * 「red/green の一致」と「MRR 実値の一致」は別の主張である。閾値判定は、MRR が閾値を大きく超えて落ちていれば
 * 実値が僅かに違っても両方 red になり得るので、前者は弱い。両方を別々に数える。
 */

export interface NoiseRoundComparison {
  sigma: number;
  seed: number;
  sparseMrr: number;
  denseMrr: number;
  mrrExactMatch: boolean;
  sparseRed: boolean;
  denseRed: boolean;
  redMatch: boolean;
}

export interface GroupNoiseComparisonSummary {
  group: string;
  totalRounds: number;
  mrrExactMatchCount: number;
  redMatchCount: number;
  mismatches: NoiseRoundComparison[];
}

/** `baselineSeed` は `sigma === 0` の基準値にしか使わない（スコアが変化しないので、どの seed でも基準値は変わらない）。 */
export function compareGroupNoiseOutcomes(
  group: string,
  sparseProbes: readonly CapturedProbeCandidates[],
  denseProbes: readonly CapturedProbeCandidates[],
  sigmaGrid: readonly number[],
  seeds: readonly number[],
  baselineSeed = 1,
): GroupNoiseComparisonSummary {
  const sparseBaseline = computeNoisyGroupMetrics(sparseProbes, 0, baselineSeed);
  const denseBaseline = computeNoisyGroupMetrics(denseProbes, 0, baselineSeed);

  const mismatches: NoiseRoundComparison[] = [];
  let mrrExactMatchCount = 0;
  let redMatchCount = 0;
  let totalRounds = 0;

  for (const sigma of sigmaGrid) {
    for (const seed of seeds) {
      totalRounds += 1;
      const sparseMetrics = computeNoisyGroupMetrics(sparseProbes, sigma, seed);
      const denseMetrics = computeNoisyGroupMetrics(denseProbes, sigma, seed);
      const sparseRed = decideNoiseRoundRed(group, sparseMetrics, sparseBaseline);
      const denseRed = decideNoiseRoundRed(group, denseMetrics, denseBaseline);

      const mrrExactMatch = sparseMetrics.mrrOverall === denseMetrics.mrrOverall;
      const redMatch = sparseRed === denseRed;
      if (mrrExactMatch) mrrExactMatchCount += 1;
      if (redMatch) redMatchCount += 1;

      if (!mrrExactMatch || !redMatch) {
        mismatches.push({
          sigma,
          seed,
          sparseMrr: sparseMetrics.mrrOverall,
          denseMrr: denseMetrics.mrrOverall,
          mrrExactMatch,
          sparseRed,
          denseRed,
          redMatch,
        });
      }
    }
  }

  return { group, totalRounds, mrrExactMatchCount, redMatchCount, mismatches };
}
