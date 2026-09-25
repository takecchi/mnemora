/**
 * Issue #109 残件「A」——`./synthetic-score-noise.ts` の合成ノイズ（σ・seed）を、
 * 順位だけでなく **margin（gold score − distractor score、ノイズ後）** にも掛けるための
 * 純関数。候補案1（margin基準、`./verdict-candidate-margin.ts`）を、ADR 0322 が使った
 * `local` 埋め込みの反実仮想データにも当てられるようにする。
 *
 * ⛔ **`synthetic-score-noise.ts`/`local-noise-arm.ts` には1文字も触れていない。**
 * ここは新しいファイルで、`noiseEpsilon`（変更していない・re-export のみ）を呼ぶだけである。
 *
 * `applySymmetricScoreNoise` はノイズ後のスコアを外に出さない（順位だけが観測可能な出力、
 * 同モジュールの doc コメント）ため、margin(ノイズ後)を計算するにはここで
 * `noiseEpsilon` を直接使ってスコアを組み立て直す必要がある。**`streamId`/`index` の
 * 意味は `applySymmetricScoreNoise` と揃える**——`streamId` は probe の並び順の添字、
 * `index` は `probe.candidates`(ノイズ適用前・並べ替え前の順番)の中での位置。
 */

import { noiseEpsilon } from "./synthetic-score-noise.js";
import type { CapturedProbeCandidates, ScoredCandidate } from "./synthetic-score-noise.js";

/**
 * `candidates`(ノイズ適用前)から gold/distractor を探し、`score` の差を返す。
 * どちらか一方でも見つからなければ `null`(比較不能)。
 */
export function computeCapturedMargin(
  candidates: readonly ScoredCandidate[],
  goldExternalId: string,
  distractorExternalId: string,
): number | null {
  const gold = candidates.find((c) => c.externalId === goldExternalId);
  const distractor = candidates.find((c) => c.externalId === distractorExternalId);
  if (gold === undefined || distractor === undefined) {
    return null;
  }
  return gold.score - distractor.score;
}

/**
 * `sigma`/`seed` のノイズを掛けた**後**の margin。`sigma === 0` のときは
 * `noiseEpsilon` の値に関わらず `computeCapturedMargin` と同じ値になる
 * （`applySymmetricScoreNoise` と同じ代数的性質）。
 */
export function computeNoisyMargin(
  candidates: readonly ScoredCandidate[],
  goldExternalId: string,
  distractorExternalId: string,
  sigma: number,
  seed: number,
  streamId: number,
): number | null {
  const goldIndex = candidates.findIndex((c) => c.externalId === goldExternalId);
  const distractorIndex = candidates.findIndex((c) => c.externalId === distractorExternalId);
  if (goldIndex === -1 || distractorIndex === -1) {
    return null;
  }
  const goldScore =
    candidates[goldIndex]!.score * (1 + sigma * noiseEpsilon(seed, streamId, goldIndex));
  const distractorScore =
    candidates[distractorIndex]!.score *
    (1 + sigma * noiseEpsilon(seed, streamId, distractorIndex));
  return goldScore - distractorScore;
}

/**
 * 1群の捕捉済み probe 集合すべてに対して、`(sigma, seed)` のノイズ後 margin の配列を返す
 * （probe の並び順のまま。`decideEmbeddingDriftVerdictByMargin` にそのまま渡せる形）。
 */
export function noisyMarginsForGroup(
  probes: readonly CapturedProbeCandidates[],
  sigma: number,
  seed: number,
): (number | null)[] {
  return probes.map((probe, streamId) =>
    computeNoisyMargin(
      probe.candidates,
      probe.goldExternalId,
      probe.distractorExternalId,
      sigma,
      seed,
      streamId,
    ),
  );
}
