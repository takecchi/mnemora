/**
 * Issue #109「これが覆るとしたら」第1項の残債（ADR 0316 の「引き受けた負債」1番、
 * ADR 0276 §「Issue #572 段1」）——`local` 埋め込みの識別子系5群＋数詞2群
 * （ADR 0316 が「既存5+2群」と呼ぶもの）は**決定的**（ADR 0094 が2 run のビット一致で
 * 確認済み）であり、ADR 0316 が使った「同じ設定で独立に録り直す」という手法（OpenAI 実
 * 埋め込みの呼び出し揺れ）が測る対象そのものが存在しない。
 *
 * 🔴🔴 **この module が測るのは「実際の偽陽性率」ではない。**
 * `local` の揺れは一度も観測されていない（ADR 0094 は2 run のビット一致を確認しただけ）。
 * ここで測るのは**反実仮想**——「もしスコア（`RecalledMemory.score.total`）に
 * [Issue #572](https://github.com/takecchi/mnemora/issues/572) と同じ形の対称な合成
 * ノイズ `× (1 + σ·ε)` が入ったとしたら、ADR 0316 の判定（`decideEmbeddingDriftVerdict`、
 * 変えていない・再利用している）は何回に1回 red になるか」という、仮に揺れがあった場合の
 * 上限の見積もりである。
 *
 * ## 注入点はスコアであって埋め込みベクトルではない
 *
 * `ScoreBreakdown.total = affinity × decay × tagMatch × freshness × strength`
 * （`packages/core/src/strategies/scoring.ts`）。`affinity` に `× (1+σ·ε)` を掛けるのと
 * `total` に同じ係数を掛けるのは**数学的に同じ結果になる**——`affinity` 以外の4項は
 * 候補ごとに固定の正の乗数として掛かっているだけなので、
 * `(affinity·(1+σε)) · decay · tagMatch · freshness · strength`
 * `= (affinity · decay · tagMatch · freshness · strength) · (1+σε) = total · (1+σε)`
 * が候補ごとの `decay`/`tagMatch`/`freshness`/`strength` の値に関わらず常に成り立つ。
 * ⟹ **`total`（`runtime.recall()` が返す `RecalledMemory.score.total`。候補の並び順を
 * 決める唯一の値）へノイズを掛けることは、`affinity` へ掛けるのと同義であり、
 * `packages/core`/`packages/postgres` のスコア計算そのものには一切触れない。**
 * `runtime.recall()` を呼んだ後、返ってきた候補配列をこの module の純関数で
 * 並べ替え直すだけである（本番の recall パイプライン・公開 API は1文字も変えていない）。
 *
 * ## σ 格子・seed 数の出所
 *
 * `SIGMA_GRID`（11段）・`SEED_COUNT`（15）は、Issue #572 の2件目のコメント
 * （【受】、この module の作者は再導出していない）が実際に走らせた「対称な差分ノイズ
 * （`affinity × (1 + σ·ε)`、ε は決定的な一様 `[−1,+1)`、σ 11段 × seed 15通り = 165 run）」
 * の値をそのまま写した。**#572 自身の計装コードは `main` に入っていない**
 * （このリポジトリのどのブランチにも存在しない）ため、**乱数生成の実装（`noiseEpsilon`）は
 * この module が独自に書いたものであり、#572 のものとビット一致しない。** #572 が
 * 「決定的な一様」とだけ書いていて、具体的な PRNG を明示していないため、再現不能——
 * ここは【確かめていないこと】として ADR に残す。σ の11値と seed 数15、そして
 * 判定に使う「偽陽性の帯」の定義（下記）は #572 に揃えたが、**個々の乱数列は #572 と
 * 同じにならない。**
 */

import { DEFAULT_MRR_DROP_THRESHOLD, decideEmbeddingDriftVerdict } from "./openai-arm-verdict.js";
import type { ProxyGroupMetrics } from "./openai-arm-verdict.js";

/** Issue #572 の2件目のコメントが実際に走らせた σ 格子（11段）。測る前に固定する。 */
export const SIGMA_GRID: readonly number[] = [
  0.0025, 0.005, 0.01, 0.02, 0.04, 0.08, 0.12, 0.16, 0.24, 0.32, 0.48,
];

/** Issue #572 と同じ seed 数（15）。測る前に固定する。 */
export const SEED_COUNT = 15;

/** `1..SEED_COUNT` の seed 列。0 は「ノイズ無し（σ=0 の基準線）」の意味に予約し、使わない。 */
export const SEEDS: readonly number[] = Array.from({ length: SEED_COUNT }, (_, i) => i + 1);

// ---------------------------------------------------------------------------
// 決定的な擬似乱数（この module 独自の実装。#572 の計装とはビット一致しない——上の doc 参照）
// ---------------------------------------------------------------------------

/**
 * 3つの整数を混ぜて32bit のハッシュを作る（FNV-1a 由来の定数を使った、この repo 用の
 * 素朴な実装。暗号強度は要らない——「同じ入力なら常に同じ出力」「入力が1つでも違えば
 * 出力が大きく変わる」の2つだけが要件）。
 */
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

/**
 * `(seed, streamId, index)` から、決定的な一様分布 `[-1, 1)` の値を1つ作る。
 *
 * - `seed`: どの「ノイズの引き」かを分ける（1..SEED_COUNT）。
 * - `streamId`: 同じ seed でも probe ごとに別の乱数列にするための添字
 *   （group 内の probe の並び順の index を渡す想定）。
 * - `index`: 1 probe の候補配列の中での位置（0始まり）。**候補の識別子や値には依存しない**
 *   ——同じ位置には常に同じノイズが掛かる。これにより「gold だけ狙って下げる」ような
 *   非対称なノイズは、この関数の中には存在しない（gold かどうかは呼び出し側にしか
 *   分からない）。
 *
 * `sigma === 0` のとき、呼び出し側は `1 + 0·ε = 1` になるため、この関数の戻り値に
 * 関わらずスコアは変化しない——**σ=0 が厳密にノイズ無しであることは、この関数の
 * 性質にすら依存しない**（呼び出し側の掛け算の代数的性質による）。
 */
export function noiseEpsilon(seed: number, streamId: number, index: number): number {
  const h = hash32(seed, streamId, index);
  // h ∈ [0, 2^32-1] → [0, 1) → [-1, 1)
  return (h / 4294967296) * 2 - 1;
}

// ---------------------------------------------------------------------------
// スコアへの注入と並べ替え
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  /** `null` は「recall() が返した候補の externalId を解決できなかった」
   *  （`resolveExternalId` が `null` を返した）ことを表す。ゴールドにも
   *  distractor にも一致しない候補として扱う。 */
  externalId: string | null;
  /** `RecalledMemory.score.total`。この値へノイズを掛ける（上の doc 参照）。 */
  score: number;
}

/**
 * `candidates`（`runtime.recall()` が返した順そのまま）へ、対称な乗算ノイズ
 * `score × (1 + σ·ε)` を掛け、ノイズ後のスコアで降順に並べ替え直す。
 *
 * **元の配列は変更しない**（新しい配列を返す）。**`externalId`/`score` は元の値のまま**
 * 返す——`ScoredCandidate` に「ノイズ後のスコア」という欄は無い。並べ替えの結果
 * （＝順位）だけが、この関数の観測可能な出力である。
 *
 * `Array.prototype.sort` は ES2019 以降 stable と規定されている——同点（ノイズを掛けても
 * 一致するスコア）の候補は元の順序を保つ。
 */
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

/** 並べ替え後の配列の中で、`externalId` が何位か（1始まり）。居なければ `null`。 */
export function rankOf(candidates: readonly ScoredCandidate[], externalId: string): number | null {
  const index = candidates.findIndex((c) => c.externalId === externalId);
  return index === -1 ? null : index + 1;
}

// ---------------------------------------------------------------------------
// probe 1件分の捕捉データ(DB 非依存。`local-noise-arm.ts` が実際の recall() から作る)
// ---------------------------------------------------------------------------

export interface CapturedProbeCandidates {
  probeId: string;
  goldExternalId: string;
  distractorExternalId: string;
  /** `runtime.recall()` が返した順そのまま(ノイズを掛ける前)。 */
  candidates: readonly ScoredCandidate[];
}

export interface NoiseRoundMetrics {
  mrrOverall: number;
  hit1Count: number;
  /** `goldRank !== null`(`identifier-arm.ts` の `hit10` と同じ定義——limit の窓に
   *  入ったかどうか。「10位以内」という意味ではない点も同じ)。 */
  hit10Count: number;
  probeCount: number;
}

/**
 * 1群の捕捉済み候補集合に、指定した `(sigma, seed)` のノイズを掛けて並べ替え、
 * MRR/hit@1/hit@10 を再計算する。**DB を一切呼ばない**——`captureGroupCandidates`
 * （`local-noise-arm.ts`）が1度だけ本物の `recall()` を呼んで捕まえた候補集合を、
 * ここで何度でも安く再利用する。
 *
 * `sigma === 0` を渡すと、`noiseEpsilon` の値に関わらずスコアが変化しないため、
 * 常に「ノイズ無しの実測（基準線）」と同じ順位になる(`applySymmetricScoreNoise` の doc)。
 */
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

// ---------------------------------------------------------------------------
// σ ごとの集計・「偽陽性の帯」の判定
// ---------------------------------------------------------------------------

/** 値の中央値(要素数が偶数なら中央2つの平均)。空配列は呼び出し側の契約違反として例外。 */
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
  /** 15 seed のうち、`decideEmbeddingDriftVerdict` が red と判定した run 数。 */
  redCount: number;
  seedCount: number;
  mrrMin: number;
  mrrMedian: number;
  mrrMax: number;
  /**
   * 「MRR の中央値が基準（σ=0）のまま」の帯に入っているか(Issue #572 が使った
   * 偽陽性の帯の定義。`docs/decisions/` 新設 ADR 参照)。**この帯に入っている σ で
   * red になった run は、品質が(中央値で見る限り)落ちていないのに red になっている
   * ——偽陽性の代理として数える対象。**
   */
  medianPreservesBaseline: boolean;
}

/**
 * `redCounts`/`mrrValues` は σ ごとに1件、内側の配列が seed ごとの値
 * （`redFlags[i]`/`mrrValues[i]` は長さ `SEED_COUNT` の配列）。
 */
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

/** 「偽陽性の帯」（`medianPreservesBaseline` な σ 群）だけを取り出し、redCount/n を合算する。 */
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

// ---------------------------------------------------------------------------
// 判定への配線 —— ADR 0316 の判定をそのまま使う(唯一の呼び出し口)
// ---------------------------------------------------------------------------

/**
 * 1 round(1つの `(sigma, seed)`)の red/green を、ADR 0316 の
 * `decideEmbeddingDriftVerdict`（`openai-arm-verdict.ts`。**変更していない**）で判定する。
 *
 * ⭐ **この module・`local-noise-arm.ts`・`scripts/local-embedding-synthetic-noise-fp.ts`
 * のうち、`decideEmbeddingDriftVerdict` を呼ぶ箇所はここ1か所だけにする。**
 * 呼び出し側で `mrrDropThreshold` を上書きしない(引数を渡さない——ADR 0316 の既定
 * `DEFAULT_MRR_DROP_THRESHOLD` をそのまま使う)。**判定を独自に厳しく/緩くしたくなったら、
 * この関数のこの1行を見ればよい**——`examples/chat/src/__tests__/synthetic-score-noise.test.ts`
 * の `decideNoiseRoundRed` の歯が、閾値の境界(0.01ちょうど・その前後)を検査している。
 */
export function decideNoiseRoundRed(
  group: string,
  measured: NoiseRoundMetrics,
  baseline: NoiseRoundMetrics,
): boolean {
  const toProxy = (m: NoiseRoundMetrics): ProxyGroupMetrics => ({ group, ...m });
  return decideEmbeddingDriftVerdict([toProxy(measured)], [toProxy(baseline)]).red;
}

/** `DEFAULT_MRR_DROP_THRESHOLD`(ADR 0316)を、この module からも参照できるよう re-export する。 */
export { DEFAULT_MRR_DROP_THRESHOLD };
