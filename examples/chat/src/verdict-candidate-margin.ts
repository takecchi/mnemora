/**
 * Issue #109 残件「A」——ADR 0316/0322 の判定（`decideEmbeddingDriftVerdict`、
 * hit@1 が1件でも基準値未満・MRR が0.01以上落ちたら red）に対する**候補案1「margin基準」**
 * の純関数（マネージャーからの実測依頼、`/tmp/mgr-65f771d7/results-A.md` に結果メモ）。
 *
 * ⛔ **これは門ではない。**`openai-arm-verdict.ts`（既存の判定コード）には1文字も
 * 触れていない——ここは新しいファイルで、既存の `computeMarginStats`
 * （`identifier-arm.ts`、変更していない）と `clopperPearsonUpperBound`
 * （`openai-arm-verdict.ts`、変更していない）を呼ぶだけである。
 *
 * ## 発想
 *
 * 現行の判定（ADR 0316）は「hit@1 が1件でも下回ったら red」であり、識別子2群では
 * gold/distractor の margin（`similarity(gold) − similarity(distractor)`）が僅差の
 * probe が複数あるため、実 API の呼び出し揺れだけで順位が入れ替わり、頻繁に red が出る
 * （ADR 0316 §「測ったこと」——合算118巡で33件）。
 *
 * **margin基準は、hit@1 という二値ではなく、margin という連続値の「縮み幅」を見る。**
 * 順位が入れ替わっても、margin の縮みが小さければ「僅差が僅差のまま入れ替わっただけ」
 * として red にせず、**複数の probe で・baseline の標本標準偏差の数倍という大きさで**
 * 縮んだときだけ red にする。
 *
 * ## 閾値の決め方（測定前に固定。後出しにしない）
 *
 * - **単位は baseline の margin の標本標準偏差（`computeMarginStats(baselineMargins).stdDev`）。**
 *   識別子群と数詞群では margin の絶対スケールが異なる（識別子群は margin が小さい、
 *   ADR 0316 の指摘）ため、絶対値の閾値ではなく「その群自身のばらつきの何倍か」という
 *   相対的な単位を使う——群ごとにスケールが違っても同じ係数を使い回せる。
 * - **`stdDevMultiplier = 3`**（既定）。「3標準偏差」は変化検知でよく使われる目安
 *   （正規分布なら平均から3σ以上外れる観測は稀）であり、この repo・この測定に
 *   固有の値ではない、外部の一般的な目安をそのまま採用した。
 * - **`minShrunkProbes = 2`**（既定）。**1件では red にしない**——現行の hit@1 判定が
 *   まさに「1件でも」で FP を出しているため、そこを緩めるのがこの案の趣旨である。
 *   2件以上・同時に大きく縮んだときだけ red にする（複数 probe が同時に動くのは、
 *   個々の近接候補がたまたま入れ替わるより、埋め込み空間そのものが動いた徴候として
 *   もっともらしい、という判断）。
 * - **baseline の margin の標本標準偏差が定義できない（`count < 2` または `stdDev === 0`）
 *   ときは red にしない。**「比較できない」を「悪化した」と同じ顔にしない
 *   （ADR 0008「無いには種類がある」の、この判定への適用。`decideEmbeddingDriftVerdict`
 *   が「基準値に無い群は red にしない」としているのと同じ形）。
 */

import { computeMarginStats } from "./identifier-arm.js";
import type { MarginStats } from "./identifier-arm.js";

export interface MarginDropOptions {
  /** baseline margin の標本標準偏差の何倍を「縮んだ」とみなすか。 */
  stdDevMultiplier: number;
  /** red と判定するために必要な、縮んだ probe の最少件数。 */
  minShrunkProbes: number;
}

/** 測定前に決めた既定値（このファイルの doc コメント参照）。 */
export const DEFAULT_MARGIN_DROP_OPTIONS: MarginDropOptions = {
  stdDevMultiplier: 3,
  minShrunkProbes: 2,
};

export interface MarginDropVerdict {
  red: boolean;
  /** 縮んだ(drop >= stdDevMultiplier * unit)と判定された probe の件数。 */
  shrunkProbeCount: number;
  /** baseline・measured 双方に margin が定義されていた(比較できた) probe の件数。 */
  comparableProbeCount: number;
  baselineMarginStats: MarginStats;
  reasons: string[];
}

/**
 * 1群の margin 配列(probe の並び順で対応させること。baseline/measured は同じ長さ・
 * 同じ probe 順であることを呼び出し側が保証する)を比べ、red/green を判定する。
 */
export function decideMarginDropVerdict(
  measuredMargins: readonly (number | null)[],
  baselineMargins: readonly (number | null)[],
  options: MarginDropOptions = DEFAULT_MARGIN_DROP_OPTIONS,
): MarginDropVerdict {
  if (measuredMargins.length !== baselineMargins.length) {
    throw new Error(
      `decideMarginDropVerdict: measuredMargins と baselineMargins の長さが違う` +
        `(${measuredMargins.length} vs ${baselineMargins.length})`,
    );
  }
  const baselineMarginStats = computeMarginStats(baselineMargins);
  const unit = baselineMarginStats.stdDev;

  let shrunkProbeCount = 0;
  let comparableProbeCount = 0;
  if (unit !== null && unit > 0) {
    for (let i = 0; i < measuredMargins.length; i += 1) {
      const b = baselineMargins[i];
      const m = measuredMargins[i];
      if (b === null || b === undefined || m === null || m === undefined) {
        continue;
      }
      comparableProbeCount += 1;
      const drop = b - m;
      if (drop >= options.stdDevMultiplier * unit) {
        shrunkProbeCount += 1;
      }
    }
  }

  const judgeable = unit !== null && unit > 0;
  const red = judgeable && shrunkProbeCount >= options.minShrunkProbes;

  const reasons: string[] = [];
  if (!judgeable) {
    reasons.push(
      `baseline margin の標本標準偏差が定義できない(count=${baselineMarginStats.count}, ` +
        `stdDev=${baselineMarginStats.stdDev})——判定不能につき red にしない`,
    );
  } else if (red) {
    reasons.push(
      `margin が baseline 標準偏差×${options.stdDevMultiplier}` +
        `(=${(unit * options.stdDevMultiplier).toFixed(6)})以上縮んだ probe が` +
        `${shrunkProbeCount}件(閾値${options.minShrunkProbes}件)`,
    );
  }

  return { red, shrunkProbeCount, comparableProbeCount, baselineMarginStats, reasons };
}

export interface GroupMarginInput {
  group: string;
  measuredMargins: readonly (number | null)[];
  baselineMargins: readonly (number | null)[];
}

export interface GroupMarginVerdict {
  group: string;
  red: boolean;
  reasons: string[];
  shrunkProbeCount: number;
  comparableProbeCount: number;
}

export interface MarginDriftVerdict {
  red: boolean;
  groups: GroupMarginVerdict[];
}

/**
 * `decideEmbeddingDriftVerdict`(ADR 0316)と同じ形(群ごとに判定→いずれかが red なら
 * 束ねた判定も red)の、margin基準版。
 */
export function decideEmbeddingDriftVerdictByMargin(
  inputs: readonly GroupMarginInput[],
  options: MarginDropOptions = DEFAULT_MARGIN_DROP_OPTIONS,
): MarginDriftVerdict {
  const groups: GroupMarginVerdict[] = inputs.map((input) => {
    const v = decideMarginDropVerdict(input.measuredMargins, input.baselineMargins, options);
    return {
      group: input.group,
      red: v.red,
      reasons: v.reasons,
      shrunkProbeCount: v.shrunkProbeCount,
      comparableProbeCount: v.comparableProbeCount,
    };
  });
  return { red: groups.some((g) => g.red), groups };
}
