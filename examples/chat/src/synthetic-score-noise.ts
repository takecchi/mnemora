/**
 * 測るのは実際の偽陽性率ではなく反実仮想: `local` の揺れは一度も観測されていないので、スコアに対称な合成ノイズ `× (1 + σ·ε)` が入ったとしたら
 * `decideEmbeddingDriftVerdict` が何回に1回 red になるか、という上限を見積もる。
 * 注入点は埋め込みベクトルではなくスコア: `total` は `affinity` 以外の4項が候補ごとに固定の正の乗数なので、`total` に係数を掛けても `affinity` に掛けても結果は同じで、スコア計算本体に触れずに済む。
 * `noiseEpsilon` は Issue #572 の計装とビット一致しない（元の PRNG が不明で再現できない）。
 */

import { DEFAULT_MRR_DROP_THRESHOLD, decideEmbeddingDriftVerdict } from "./openai-arm-verdict.js";
import type { ProxyGroupMetrics } from "./openai-arm-verdict.js";

export const SIGMA_GRID: readonly number[] = [
  0.0025, 0.005, 0.01, 0.02, 0.04, 0.08, 0.12, 0.16, 0.24, 0.32, 0.48,
];

export const SEED_COUNT = 15;

/** `1..SEED_COUNT` の seed 列。0 は「ノイズ無し（σ=0 の基準線）」の意味に予約し、使わない。 */
export const SEEDS: readonly number[] = Array.from({ length: SEED_COUNT }, (_, i) => i + 1);

function hash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5 ^ (a >>> 0);
  h = Math.imul(h ^ (b >>> 0), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h ^ (c >>> 0), 0x01000193);
  h ^= h >>> 13;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 添字は位置だけに依存し、候補の識別子や値には依存しない（「gold だけ狙って下げる」非対称なノイズをここに作らない）。 */
export function noiseEpsilon(seed: number, streamId: number, index: number): number {
  const h = hash32(seed, streamId, index);
  return (h / 4294967296) * 2 - 1;
}

export interface ScoredCandidate {
  externalId: string | null;
  score: number;
}

export function applySymmetricScoreNoise(
  candidates: readonly ScoredCandidate[],
  sigma: number,
  seed: number,
  streamId: number,
): ScoredCandidate[] {
  return candidates
    .map((c, index) => ({
      candidate: c,
      noisyScore: c.score * (1 + sigma * noiseEpsilon(seed, streamId, index)),
    }))
    .sort((a, b) => b.noisyScore - a.noisyScore)
    .map((entry) => entry.candidate);
}

export function rankOf(candidates: readonly ScoredCandidate[], externalId: string): number | null {
  const index = candidates.findIndex((c) => c.externalId === externalId);
  return index === -1 ? null : index + 1;
}

export interface CapturedProbeCandidates {
  probeId: string;
  goldExternalId: string;
  distractorExternalId: string;
  candidates: readonly ScoredCandidate[];
}

export interface NoiseRoundMetrics {
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
}

export function computeNoisyGroupMetrics(
  probes: readonly CapturedProbeCandidates[],
  sigma: number,
  seed: number,
): NoiseRoundMetrics {
  let reciprocalSum = 0;
  let hit1Count = 0;
  let hit10Count = 0;
  probes.forEach((probe, streamId) => {
    const reordered = applySymmetricScoreNoise(probe.candidates, sigma, seed, streamId);
    const goldRank = rankOf(reordered, probe.goldExternalId);
    reciprocalSum += goldRank !== null ? 1 / goldRank : 0;
    if (goldRank === 1) {
      hit1Count += 1;
    }
    if (goldRank !== null) {
      hit10Count += 1;
    }
  });
  return {
    mrrOverall: probes.length === 0 ? 0 : reciprocalSum / probes.length,
    hit1Count,
    hit10Count,
    probeCount: probes.length,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("median: 空配列には中央値が無い");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface SigmaLevelSummary {
  sigma: number;
  redCount: number;
  seedCount: number;
  mrrMin: number;
  mrrMedian: number;
  mrrMax: number;
  medianPreservesBaseline: boolean;
}

export function summarizeSigmaLevels(
  sigmaGrid: readonly number[],
  redFlagsPerSigma: readonly (readonly boolean[])[],
  mrrPerSigma: readonly (readonly number[])[],
  baselineMrr: number,
): SigmaLevelSummary[] {
  if (sigmaGrid.length !== redFlagsPerSigma.length || sigmaGrid.length !== mrrPerSigma.length) {
    throw new Error("summarizeSigmaLevels: sigmaGrid と各配列の長さが揃っていない");
  }
  return sigmaGrid.map((sigma, i) => {
    const redFlags = redFlagsPerSigma[i]!;
    const mrrValues = mrrPerSigma[i]!;
    const redCount = redFlags.filter(Boolean).length;
    const mrrMedian = median(mrrValues);
    return {
      sigma,
      redCount,
      seedCount: redFlags.length,
      mrrMin: Math.min(...mrrValues),
      mrrMedian,
      mrrMax: Math.max(...mrrValues),
      medianPreservesBaseline: mrrMedian === baselineMrr,
    };
  });
}

export function aggregateFalsePositiveBand(levels: readonly SigmaLevelSummary[]): {
  bandSigmas: number[];
  redCount: number;
  trials: number;
} {
  const band = levels.filter((l) => l.medianPreservesBaseline);
  return {
    bandSigmas: band.map((l) => l.sigma),
    redCount: band.reduce((sum, l) => sum + l.redCount, 0),
    trials: band.reduce((sum, l) => sum + l.seedCount, 0),
  };
}

/** `decideEmbeddingDriftVerdict` を呼ぶ箇所はここ1か所だけにする。`mrrDropThreshold` は上書きしない（ADR 0316 の既定をそのまま使う）。 */
export function decideNoiseRoundRed(
  group: string,
  measured: NoiseRoundMetrics,
  baseline: NoiseRoundMetrics,
): boolean {
  const toProxy = (m: NoiseRoundMetrics): ProxyGroupMetrics => ({ group, ...m });
  return decideEmbeddingDriftVerdict([toProxy(measured)], [toProxy(baseline)]).red;
}

export { DEFAULT_MRR_DROP_THRESHOLD };
