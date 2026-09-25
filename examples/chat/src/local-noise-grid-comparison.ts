import type { CapturedProbeCandidates } from "./synthetic-score-noise.js";
import { computeNoisyGroupMetrics, decideNoiseRoundRed } from "./synthetic-score-noise.js";

/**
 * Issue #109（06:58Z のコメント4番）が「仮説のみで未確認」と残した
 * 「ADR 0322 の sparse/dense 群の結果が σ・seed の全組で完全に一致した」という主張
 * そのものを、σ 格子 × seed 全通り（既定 165 通り）にわたって実際に再計算し、
 * 数値として突き合わせる。**`local-noise-candidate-diff.ts` は入力（候補集合）が
 * 同じかどうかだけを見るが、こちらは `synthetic-score-noise.ts` の既存関数
 * （`computeNoisyGroupMetrics`/`decideNoiseRoundRed`。1文字も変更していない）を
 * そのまま呼び、出力（MRR 実値・red/green の判定）まで sparse/dense で突き合わせる。**
 *
 * ⚠ **「red/green が一致する」ことと「MRR の実値が一致する」ことは別の主張である。**
 * `decideEmbeddingDriftVerdict` は閾値判定（`mrrDrop >= threshold` で red）なので、
 * MRR が閾値を大きく超えて落ちていれば、sparse/dense の実値が僅かに違っていても
 * どちらも red になり得る——「red/green の一致」は「MRR 実値の一致」より弱い主張である。
 * このモジュールは両方を別々に数える。
 */

export interface NoiseRoundComparison {
  sigma: number;
  seed: number;
  sparseMrr: number;
  denseMrr: number;
  /** MRR の実値が sparse/dense で厳密に一致するか（`===`）。 */
  mrrExactMatch: boolean;
  sparseRed: boolean;
  denseRed: boolean;
  /** `decideNoiseRoundRed` の red/green 判定が sparse/dense で一致するか。 */
  redMatch: boolean;
}

export interface GroupNoiseComparisonSummary {
  group: string;
  totalRounds: number;
  mrrExactMatchCount: number;
  redMatchCount: number;
  /** `mrrExactMatch: false` または `redMatch: false` だった round だけを残す。 */
  mismatches: NoiseRoundComparison[];
}

/**
 * `sigmaGrid × seeds` の全組について、sparse/dense それぞれの捕捉済み候補集合
 * （`local-noise-arm.ts` の `captureGroupCandidates` が1回だけ本物の `recall()` を
 * 呼んで捕まえたもの）に同じ `(sigma, seed)` のノイズを掛け、MRR・red 判定を
 * 独立に計算して突き合わせる。**DB を一切呼ばない**（`computeNoisyGroupMetrics`/
 * `decideNoiseRoundRed` は純関数）。
 *
 * `baselineSeed`（既定 `1`）は `computeNoisyGroupMetrics(probes, 0, baselineSeed)` の
 * 呼び出しにのみ使う——`sigma === 0` のときスコアは変化しないため（`synthetic-score-noise.ts`
 * の doc 参照）、どの seed を渡しても基準値は変わらない。`local-embedding-synthetic-noise-fp.ts`
 * が使っている `seed=1` に揃えた。
 */
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
