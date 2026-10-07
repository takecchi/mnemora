/**
 * 門ではない。hit@1 という二値ではなく margin の「縮み幅」を見る: 順位が入れ替わっても縮みが小さければ red にしない。
 * 単位は baseline の margin の標本標準偏差（群ごとにスケールが違うため絶対値の閾値にしない）。`stdDevMultiplier = 3` は変化検知の一般的な目安で、この測定に固有の値ではない。
 * `minShrunkProbes = 2`: 1件では red にしない（現行の hit@1 判定が「1件でも」で偽陽性を出しているため）。
 * 標本標準偏差が定義できない（`count < 2` または `stdDev === 0`）ときは red にしない（「比較できない」を「悪化した」と同じ顔にしない）。
 * 閾値は測定前に固定する（後出しにしない）。
 */

import { computeMarginStats } from "./identifier-arm.js";
import type { MarginStats } from "./identifier-arm.js";

export interface MarginDropOptions {
  stdDevMultiplier: number;
  minShrunkProbes: number;
}

export const DEFAULT_MARGIN_DROP_OPTIONS: MarginDropOptions = {
  stdDevMultiplier: 3,
  minShrunkProbes: 2,
};

export interface MarginDropVerdict {
  red: boolean;
  shrunkProbeCount: number;
  comparableProbeCount: number;
  baselineMarginStats: MarginStats;
  reasons: string[];
}

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
