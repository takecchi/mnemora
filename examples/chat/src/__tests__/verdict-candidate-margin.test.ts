import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARGIN_DROP_OPTIONS,
  decideEmbeddingDriftVerdictByMargin,
  decideMarginDropVerdict,
} from "../verdict-candidate-margin.js";

/**
 * `verdict-candidate-margin.ts`（Issue #109 残件「A」候補案1）の歯。
 * DB もネットワークも要らない——margin の配列を手で組み立てて渡すだけ。
 */

describe("decideMarginDropVerdict", () => {
  it("baseline と measured が同じなら red にならない(縮みが無い)", () => {
    const baseline = [0.5, 0.4, 0.3, 0.6, 0.2];
    const measured = [0.5, 0.4, 0.3, 0.6, 0.2];
    const v = decideMarginDropVerdict(measured, baseline);
    expect(v.red).toBe(false);
    expect(v.shrunkProbeCount).toBe(0);
  });

  it("1 probe だけ大きく縮んでも red にならない(閾値minShrunkProbes=2)", () => {
    // baseline: 平均0.4、標準偏差はそこそこの分布にする
    const baseline = [0.1, 0.2, 0.3, 0.4, 0.9];
    const stats_unit = (() => {
      const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
      const variance = baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / (baseline.length - 1);
      return Math.sqrt(variance);
    })();
    // 1件だけ、3標準偏差以上縮める
    const measured = [...baseline];
    measured[4] = baseline[4]! - stats_unit * 4;
    const v = decideMarginDropVerdict(measured, baseline);
    expect(v.shrunkProbeCount).toBe(1);
    expect(v.red).toBe(false);
  });

  it("2 probe が同時に3標準偏差以上縮んだら red になる", () => {
    const baseline = [0.1, 0.2, 0.3, 0.4, 0.9];
    const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const variance = baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / (baseline.length - 1);
    const unit = Math.sqrt(variance);
    const measured = [...baseline];
    measured[3] = baseline[3]! - unit * 4;
    measured[4] = baseline[4]! - unit * 4;
    const v = decideMarginDropVerdict(measured, baseline);
    expect(v.shrunkProbeCount).toBe(2);
    expect(v.red).toBe(true);
    expect(v.reasons[0]).toMatch(/縮んだ probe が2件/);
  });

  it("baseline margin が全て同じ(標準偏差0)なら、どれだけ縮んでも判定不能につき red にしない", () => {
    const baseline = [0.3, 0.3, 0.3, 0.3];
    const measured = [-5, -5, -5, -5];
    const v = decideMarginDropVerdict(measured, baseline);
    expect(v.red).toBe(false);
    expect(v.reasons[0]).toMatch(/判定不能/);
  });

  it("baseline margin が1件しかない(count<2で標準偏差が定義できない)なら red にしない", () => {
    const baseline = [0.3];
    const measured = [-5];
    const v = decideMarginDropVerdict(measured, baseline);
    expect(v.red).toBe(false);
    expect(v.baselineMarginStats.count).toBe(1);
  });

  it("null(比較不能)の probe は分母・分子どちらからも除く", () => {
    const baseline = [0.1, 0.2, 0.3, 0.4, 0.9];
    const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const variance = baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / (baseline.length - 1);
    const unit = Math.sqrt(variance);
    const measured: (number | null)[] = [...baseline];
    measured[3] = baseline[3]! - unit * 4;
    measured[4] = null; // 比較不能——縮んだ判定に数えない
    const v = decideMarginDropVerdict(measured, baseline);
    expect(v.comparableProbeCount).toBe(4);
    expect(v.shrunkProbeCount).toBe(1);
    expect(v.red).toBe(false);
  });

  it("測定前に固定した既定値は stdDevMultiplier=3, minShrunkProbes=2", () => {
    expect(DEFAULT_MARGIN_DROP_OPTIONS).toEqual({ stdDevMultiplier: 3, minShrunkProbes: 2 });
  });

  it("長さが違えば例外", () => {
    expect(() => decideMarginDropVerdict([0.1, 0.2], [0.1])).toThrow(/長さが違う/);
  });
});

describe("decideEmbeddingDriftVerdictByMargin", () => {
  it("いずれかの群が red なら束ねた判定も red", () => {
    const baseline = [0.1, 0.2, 0.3, 0.4, 0.9];
    const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const variance = baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / (baseline.length - 1);
    const unit = Math.sqrt(variance);
    const shrunkMeasured = [...baseline];
    shrunkMeasured[3] = baseline[3]! - unit * 4;
    shrunkMeasured[4] = baseline[4]! - unit * 4;

    const result = decideEmbeddingDriftVerdictByMargin([
      { group: "stable", measuredMargins: baseline, baselineMargins: baseline },
      { group: "shrunk", measuredMargins: shrunkMeasured, baselineMargins: baseline },
    ]);
    expect(result.red).toBe(true);
    expect(result.groups.find((g) => g.group === "stable")!.red).toBe(false);
    expect(result.groups.find((g) => g.group === "shrunk")!.red).toBe(true);
  });

  it("全群 green なら束ねた判定も green", () => {
    const baseline = [0.1, 0.2, 0.3, 0.4, 0.9];
    const result = decideEmbeddingDriftVerdictByMargin([
      { group: "a", measuredMargins: baseline, baselineMargins: baseline },
      { group: "b", measuredMargins: baseline, baselineMargins: baseline },
    ]);
    expect(result.red).toBe(false);
  });
});
