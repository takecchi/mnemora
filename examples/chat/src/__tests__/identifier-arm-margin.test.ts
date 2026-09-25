import { describe, expect, it } from "vitest";
import { computeMargin, computeMarginStats } from "../identifier-arm.js";
import type { ProbeScoreDetail } from "../retrieval-quality.js";

/**
 * `identifier-arm.ts` の `margin`(ADR 0135 §5.5)を計算する純関数の歯。
 * DB もネットワークも要らない——`ProbeScoreDetail` を手で組み立てて渡すだけ。
 *
 * ⭐ **この歯が実際に噛むこと自体を、変異試験で示した**(報告に記録)——
 * `computeMargin` の減算を加算に変える/`computeMarginStats` の `n-1` を `n` に
 * 変えるといった変異を入れて、ここの assertion が実際に赤くなることを確認し、
 * 戻して緑に戻ることまで確かめた。
 */

function scoreDetail(roles: ProbeScoreDetail["roles"], similarity: number | undefined) {
  return {
    roles,
    rank: 1,
    digest: "d",
    score: {
      similarity,
      decay: 1,
      tagMatch: 1,
      freshness: 1,
      strength: 1,
      total: 1,
    },
  } satisfies ProbeScoreDetail;
}

describe("computeMargin", () => {
  it("similarity(gold) - similarity(distractor) を返す", () => {
    const details = [scoreDetail(["gold"], 0.8), scoreDetail(["distractor"], 0.3)];
    expect(computeMargin(details)).toBeCloseTo(0.5, 10);
  });

  it("gold が scoreDetails に無ければ null", () => {
    const details = [scoreDetail(["distractor"], 0.3)];
    expect(computeMargin(details)).toBeNull();
  });

  it("distractor が scoreDetails に無ければ null", () => {
    const details = [scoreDetail(["gold"], 0.8)];
    expect(computeMargin(details)).toBeNull();
  });

  it("gold/distractor の similarity 自体が無ければ null(語彙チャンネル経由等)", () => {
    const details = [scoreDetail(["gold"], undefined), scoreDetail(["distractor"], 0.3)];
    expect(computeMargin(details)).toBeNull();
  });

  it("gold が同時に1位でもある(roles複数)場合も同じ役から similarity を取る", () => {
    const details = [scoreDetail(["gold", "top1"], 0.9), scoreDetail(["distractor"], 0.1)];
    expect(computeMargin(details)).toBeCloseTo(0.8, 10);
  });

  it("負の margin(distractor が gold を上回る)も表現できる", () => {
    const details = [scoreDetail(["gold"], 0.1), scoreDetail(["distractor"], 0.9)];
    expect(computeMargin(details)).toBeCloseTo(-0.8, 10);
  });
});

describe("computeMarginStats", () => {
  it("count=0 のときすべて null", () => {
    expect(computeMarginStats([])).toEqual({ count: 0, mean: null, stdDev: null, min: null });
    expect(computeMarginStats([null, null])).toEqual({
      count: 0,
      mean: null,
      stdDev: null,
      min: null,
    });
  });

  it("null は分母から除く(0として数えない)", () => {
    const stats = computeMarginStats([0.1, null, 0.3]);
    expect(stats.count).toBe(2);
    expect(stats.mean).toBeCloseTo(0.2, 10);
    expect(stats.min).toBeCloseTo(0.1, 10);
  });

  it("count=1 のとき stdDev は null(分散を定義できない)", () => {
    const stats = computeMarginStats([0.5]);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBeCloseTo(0.5, 10);
    expect(stats.stdDev).toBeNull();
    expect(stats.min).toBeCloseTo(0.5, 10);
  });

  it("count>=2 で標本標準偏差(自由度 n-1)を計算する", () => {
    // 値: 1, 2, 3 → mean=2, 分散(n-1)=(1+0+1)/2=1 → stdDev=1
    const stats = computeMarginStats([1, 2, 3]);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBeCloseTo(2, 10);
    expect(stats.stdDev).toBeCloseTo(1, 10);
    expect(stats.min).toBeCloseTo(1, 10);
  });
});
