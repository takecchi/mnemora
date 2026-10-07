/**
 * 合成ノイズを margin（gold score − distractor score、ノイズ後）にも掛けるための純関数。
 * `applySymmetricScoreNoise` はノイズ後のスコアを外に出さないので、ここで `noiseEpsilon` を直接使って組み立て直す。
 * `streamId`/`index` の意味は `applySymmetricScoreNoise` と揃える（`streamId` は probe の並び順の添字、
 * `index` はノイズ適用前の `probe.candidates` の中での位置）。
 */

import { noiseEpsilon } from "./synthetic-score-noise.js";
import type { CapturedProbeCandidates, ScoredCandidate } from "./synthetic-score-noise.js";

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
