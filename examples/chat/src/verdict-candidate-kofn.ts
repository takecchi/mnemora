/**
 * Issue #109 残件「A」——候補案2「多数決／k-of-n」の純関数
 * （マネージャーからの実測依頼、`/tmp/mgr-65f771d7/results-A.md` に結果メモ）。
 *
 * ⛔ **既存の判定コードには1文字も触れていない。**ここは新しいファイルであり、
 * `openai-arm-verdict.ts` の `clopperPearsonUpperBound`(変更していない)を呼ぶだけである。
 *
 * ## 発想と、CI の制約を踏まえた実装可能性
 *
 * 「同一カセットの複数巡の多数決」は、**CI が1本のカセットを再生するだけ**という
 * 現行の構造とは相性が悪い——CI は決定的な再生であり、そもそも「複数巡」が存在しない
 * （`AGENTS.md` 「⟹ CI は決定的（同じカセットを毎回再生するだけ）なので、偽陽性は
 * 構造的に起きない」）。**この案を CI で実装するには、N本の独立なカセットを
 * あらかじめ録画してコミットし、CI がその全てを再生して k本以上が red なら red、
 * という形にする必要がある。**⟹ カセットを録り直すたびに、録画コストが N倍になる
 * （このファイルの `empiricalKOfNRedRate` の doc も参照）。
 *
 * 「sparse/dense 2群の一致」（同じ round 内で2つの haystack 条件が両方 red か）は、
 * 追加の録画無しに CI で実装できる（既に両方毎回実行している）。**ただし実測すると
 * 効果が無い**——118巡データで sparse の red 集合と dense の red 集合が完全に一致した
 * （後述の測定結果）。ADR 0316 の「実質的に独立な信号は6本ではなく3本」という指摘の
 * 直接の裏付けであり、この案は**このデータでは**偽陽性率を1ミリも下げない。
 *
 * ⟹ **この module は2つの道具を持つ**:
 * 1. `binomialAtLeastK` / `binomialAtLeastKUpperBound` — 「N本の独立な録画のうち
 *    k本以上が red」という方式を、**理論値**として見積もる(2項分布)。
 * 2. `empiricalKOfNRedRate` — 実際に集めた59巡（独立な録画のシミュレーション）を
 *    N個区切りの重ならない窓に割り、各窓で「k本以上red」だったかを**実測**する
 *    （理論値との整合性を確かめる陽性対照でもある）。
 */

import { clopperPearsonUpperBound } from "./openai-arm-verdict.js";

/** `n` 個から `k` 個を選ぶ組み合わせの数(小さい n 前提。log を使わない素朴な実装)。 */
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

/** 二項分布 `Binomial(n, p)` の `P(X = k)`。 */
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

/**
 * 二項分布 `Binomial(n, p)` の `P(X >= k)`——「N本のうちk本以上が red」の確率。
 * `p` には、既存の実測から得た red 率(`redCount/trials`)や、その
 * Clopper–Pearson 片側上限を代入して使う想定。
 */
export function binomialAtLeastK(k: number, n: number, p: number): number {
  let sum = 0;
  for (let i = k; i <= n; i += 1) {
    sum += binomialPMF(i, n, p);
  }
  return sum;
}

export interface EmpiricalKOfNResult {
  /** k本以上が red だった窓の数。 */
  redWindowCount: number;
  /** 重ならない窓の総数(`Math.floor(redFlags.length / n)`——余りは捨てる)。 */
  windowCount: number;
  redRate: number;
  /** `windowCount` を試行回数とした Clopper–Pearson 片側95%上限
   *  (`windowCount === 0` のときは `null`——分母0では定義できない)。 */
  clopperPearsonUpperBound95: number | null;
}

/**
 * 独立な録画列(`redFlags`、1回の録画=1 boolean)を、`n` 個ずつ・**重ならない**窓に
 * 区切り、各窓で red が `k` 本以上だったら「その窓は red」と数える。
 *
 * ⚠ **重ならない窓にする理由**: 重なる窓（sliding window）だと、隣接する窓が同じ
 * round を共有し、窓同士が独立でなくなる——その場合 Clopper–Pearson の前提
 * （試行が独立）が崩れ、上限の意味が無くなる。**重ならない窓は、それぞれ別々の
 * round だけからできているため、窓どうしは独立である**（各 round 自体が独立な
 * 実 API 呼び出しであるため——ADR 0316 の測定手順）。
 */
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

/**
 * 「sparse/dense 2群の一致」（追加録画なしで CI に実装できる、案2のもう1つの形）——
 * 同じ round で2つの群(例: `identifiersSparse`/`identifiersDense`)が**両方とも** red
 * だったときだけ red と数える。`empiricalKOfNRedRate` が「同じ群の複数録画」を
 * 束ねるのに対し、こちらは「同じ録画・違う群」を束ねる——束ね方の軸が違う。
 */
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
