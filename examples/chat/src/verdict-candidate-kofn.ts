/**
 * 候補案2「k-of-n」の純関数。CI は1本のカセットを再生するだけで「複数巡」が存在しないので、実装するには N 本の独立なカセットを録画してコミットする必要があり、録り直すたびに録画コストが N 倍になる。
 * sparse/dense 一致は追加録画なしで実装できるが、118巡のデータでは両群の red 集合が完全に一致し、偽陽性率を下げない。
 */

import { clopperPearsonUpperBound } from "./openai-arm-verdict.js";

function choose(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

export function binomialPMF(k: number, n: number, p: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0) {
    throw new Error(`binomialPMF: n/k は非負整数であること(実際: n=${n}, k=${k})`);
  }
  if (p < 0 || p > 1) {
    throw new Error(`binomialPMF: p は[0,1]であること(実際: ${p})`);
  }
  if (k < 0 || k > n) {
    return 0;
  }
  return choose(n, k) * p ** k * (1 - p) ** (n - k);
}

export function binomialAtLeastK(k: number, n: number, p: number): number {
  let sum = 0;
  for (let i = k; i <= n; i += 1) {
    sum += binomialPMF(i, n, p);
  }
  return sum;
}

export interface EmpiricalKOfNResult {
  redWindowCount: number;
  windowCount: number;
  redRate: number;
  /** `windowCount` を試行回数とした Clopper–Pearson 片側95%上限。`windowCount === 0` のときは `null`（分母0では定義できない）。 */
  clopperPearsonUpperBound95: number | null;
}

/** 窓は重ならないようにする: 重なる窓は隣接する窓が同じ round を共有して独立でなくなり、Clopper–Pearson の前提（試行が独立）が崩れる。 */
export function empiricalKOfNRedRate(
  redFlags: readonly boolean[],
  n: number,
  k: number,
): EmpiricalKOfNResult {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`empiricalKOfNRedRate: n は正の整数であること(実際: ${n})`);
  }
  if (!Number.isInteger(k) || k <= 0 || k > n) {
    throw new Error(`empiricalKOfNRedRate: k は 1<=k<=n であること(実際: k=${k}, n=${n})`);
  }
  const windowCount = Math.floor(redFlags.length / n);
  let redWindowCount = 0;
  for (let w = 0; w < windowCount; w += 1) {
    const slice = redFlags.slice(w * n, w * n + n);
    const redInWindow = slice.filter(Boolean).length;
    if (redInWindow >= k) {
      redWindowCount += 1;
    }
  }
  return {
    redWindowCount,
    windowCount,
    redRate: windowCount > 0 ? redWindowCount / windowCount : 0,
    clopperPearsonUpperBound95:
      windowCount > 0 ? clopperPearsonUpperBound(redWindowCount, windowCount, 0.05) : null,
  };
}

export interface GroupPairRedFlags {
  a: boolean;
  b: boolean;
}

export interface PairAgreementResult {
  redCount: number;
  trials: number;
  redRate: number;
  clopperPearsonUpperBound95: number | null;
}

export function pairAgreementRedRate(pairs: readonly GroupPairRedFlags[]): PairAgreementResult {
  const trials = pairs.length;
  const redCount = pairs.filter((p) => p.a && p.b).length;
  return {
    redCount,
    trials,
    redRate: trials > 0 ? redCount / trials : 0,
    clopperPearsonUpperBound95:
      trials > 0 ? clopperPearsonUpperBound(redCount, trials, 0.05) : null,
  };
}
