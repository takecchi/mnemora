/**
 * Issue #109 後半——「標本が数十件になり、その母数で偽陽性率に上限を置けると
 * 実測できたとき」（ADR 0094「これが覆るとしたら」第1項）を実測するための、
 * **偽陽性の判定（純関数）**と**Clopper–Pearson の片側上限（純関数）**。
 *
 * ⛔ **これは門ではない。**この関数はどこからも CI の exit code に接続されていない
 * ——ADR 0276 の `decideRetrievalQualityShadowVerdict` と同じ立て付け（判定を
 * 純関数として切り出し、DB もカセットも無い歯で直接検査できるようにする）。
 *
 * ## 判定を先に決める（測定前に固定する。後出しにしない）
 *
 * `examples/chat/src/scripts/openai-embedding-fp-ceiling.ts` が実際にこの関数へ
 * 通す前に、この2つの閾値を**測定前に**決めた（`docs/decisions/` の新設 ADR に記録）:
 *
 * - **hit@1 が基準値の件数を1件でも下回ったら red。**
 * - **MRR が基準値から `MRR_DROP_THRESHOLD`（既定 0.01）以上落ちたら red。**
 *
 * どちらも ADR 0276 の「MRR/hit@1 の閾値判定」と同じ形（数値の閾値・両側を別々に
 * 判定・`reasons` に理由を積む）を踏んでいるが、**基準は「絶対値」ではなく
 * 「基準値からの落ち幅」**である——この6群のうち複数（`identifiersSparse`/
 * `identifiersDense`）は基準値が天井（hit@1 = probeCount）であり、絶対値の
 * 閾値では表現できない。
 */

export interface ProxyGroupMetrics {
  group: string;
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
}

export interface DriftVerdictOptions {
  /** MRR がベースラインからこれだけ落ちたら red。 */
  mrrDropThreshold: number;
}

/** 測定前に決めた既定値（ADR、下の docstring 参照）。 */
export const DEFAULT_MRR_DROP_THRESHOLD = 0.01;

export interface GroupVerdict {
  group: string;
  red: boolean;
  reasons: string[];
}

export interface DriftVerdict {
  red: boolean;
  groups: GroupVerdict[];
}

/**
 * 実測6群と基準6群を突き合わせ、群ごとに red/green を判定する。
 * **基準値に無い群は red にしない**——「比較できない」は「悪化した」ではない
 * （ADR 0008「無いには種類がある」の、この判定への適用）。
 */
export function decideEmbeddingDriftVerdict(
  measured: readonly ProxyGroupMetrics[],
  baseline: readonly ProxyGroupMetrics[],
  options: DriftVerdictOptions = { mrrDropThreshold: DEFAULT_MRR_DROP_THRESHOLD },
): DriftVerdict {
  const baselineByGroup = new Map(baseline.map((b) => [b.group, b]));
  const groups: GroupVerdict[] = measured.map((m) => {
    const b = baselineByGroup.get(m.group);
    if (b === undefined) {
      return { group: m.group, red: false, reasons: ["基準値にこの群が無い(比較していない)"] };
    }
    const reasons: string[] = [];
    if (m.hit1Count < b.hit1Count) {
      reasons.push(
        `hit@1 ${m.hit1Count}/${m.probeCount} が基準値 ${b.hit1Count}/${b.probeCount} を下回った`,
      );
    }
    const mrrDrop = b.mrrOverall - m.mrrOverall;
    if (mrrDrop >= options.mrrDropThreshold) {
      reasons.push(
        `MRR ${m.mrrOverall} が基準値 ${b.mrrOverall} から ${mrrDrop.toFixed(6)} 落ちた` +
          `(閾値 ${options.mrrDropThreshold})`,
      );
    }
    return { group: m.group, red: reasons.length > 0, reasons };
  });
  return { red: groups.some((g) => g.red), groups };
}

// ---------------------------------------------------------------------------
// Clopper–Pearson の片側上限（正規化不完全ベータ関数を自前で実装する）
// ---------------------------------------------------------------------------

/**
 * Lanczos 近似（g=7, n=9 項）による `ln(Γ(x))`。**公開されている標準の近似式**
 * （係数は Numerical Recipes / Wikipedia 等で広く再掲されている定数であり、
 * 特定の著作物の文章を書き写したものではない）を、この repo 用に書き直したもの。
 */
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) {
    // 反射公式（Γ(x)Γ(1-x) = π / sin(πx)）。
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xx = x - 1;
  let a = LANCZOS_COEFFICIENTS[0]!;
  const t = xx + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    a += LANCZOS_COEFFICIENTS[i]! / (xx + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * 不完全ベータ関数の連分数展開（modified Lentz 法）。
 * `regularizedIncompleteBeta` の内部でのみ使う。
 */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < EPS) {
      break;
    }
  }
  return h;
}

/**
 * 正規化不完全ベータ関数 `I_x(a, b)`(= Beta(a,b) 分布の累積分布関数、x∈[0,1])。
 *
 * 【実測】`examples/chat/src/__tests__/openai-arm-verdict.test.ts` が、閉じた式で
 * 検算できる場合（a=1 のとき `I_x(1,b) = 1-(1-x)^b`）との一致を確認している。
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBt = a * Math.log(x) + b * Math.log(1 - x) + logGamma(a + b) - logGamma(a) - logGamma(b);
  const bt = Math.exp(logBt);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (bt * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * `regularizedIncompleteBeta` を `p` について反転する（二分探索。単調増加なので安全）。
 * 解 `x` は `regularizedIncompleteBeta(x, a, b) === q` を満たす。
 */
function invertIncompleteBeta(q: number, a: number, b: number): number {
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const value = regularizedIncompleteBeta(mid, a, b);
    if (value > q) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Clopper–Pearson の**片側**上限（100(1-alpha)%）。
 *
 * `trials` 回中 `successes` 回「red」が出たとき、真の red 率 p の片側上限は
 * `U = BetaInv(1-alpha; successes+1, trials-successes)`
 * （`successes === trials` のときは 1）。
 *
 * `successes === 0` の閉じた式 `U = 1 - alpha^(1/trials)` と一致することを
 * 歯（`openai-arm-verdict.test.ts`）で検算している。
 */
export function clopperPearsonUpperBound(successes: number, trials: number, alpha = 0.05): number {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials <= 0) {
    throw new Error(
      `clopperPearsonUpperBound: successes/trials は正の整数であること(実際: ${successes}/${trials})`,
    );
  }
  if (successes < 0 || successes > trials) {
    throw new Error(
      `clopperPearsonUpperBound: 0 <= successes <= trials であること(実際: ${successes}/${trials})`,
    );
  }
  if (successes === trials) {
    return 1;
  }
  return invertIncompleteBeta(1 - alpha, successes + 1, trials - successes);
}
