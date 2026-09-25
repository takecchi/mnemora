import { describe, expect, it } from "vitest";
import {
  computeProtectionMargin,
  computeSignedMarginStats,
  maxNonProtectedScore,
  scoresMatchWithinJitter,
} from "../intrusion-margin-candidates.js";

/**
 * Issue #109 残件C（マネージャー依頼）——`intrusion-margin-candidates.ts` の純関数の歯。
 * DB もネットワークも要らない——値を手で組み立てて渡すだけ
 * （`correction-candidate-arm-margin.test.ts` と同じ規律）。
 */

describe("maxNonProtectedScore", () => {
  it("protectedIds に含まれない候補のうち最大スコアを返す", () => {
    const memories = [{ score: { total: 0.9 } }, { score: { total: 0.5 } }];
    const externalIds = ["protected", "intruder"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeCloseTo(0.5, 10);
  });

  it("複数の非保護候補があれば最大を選ぶ（最有力の『訂正に使われうる候補』）", () => {
    const memories = [
      { score: { total: 0.9 } },
      { score: { total: 0.5 } },
      { score: { total: 0.7 } },
    ];
    const externalIds = ["protected", "intruder-weak", "intruder-strong"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeCloseTo(0.7, 10);
  });

  it("全件が保護対象なら null（訂正に使われうる候補が無い）", () => {
    const memories = [{ score: { total: 0.9 } }];
    const externalIds = ["protected"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeNull();
  });

  it("externalId が null の要素は非保護として扱う（未解決の候補、minProtectedFactScore と対称）", () => {
    const memories = [{ score: { total: 0.9 } }, { score: { total: 0.2 } }];
    const externalIds = [null, "protected"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeCloseTo(0.9, 10);
  });

  it("空配列なら null", () => {
    expect(maxNonProtectedScore([], [], ["a"])).toBeNull();
  });
});

describe("computeProtectionMargin", () => {
  it("深い誤爆側（保護対象が最有力の非保護候補より高い）は正の値", () => {
    // 保護対象0.9、最有力の非保護候補0.7 ⟹ 保護対象が1位に来る（深い誤爆）状況を表す。
    expect(computeProtectionMargin(0.9, 0.7)).toBeCloseTo(0.2, 10);
  });

  it("誤爆(浅)側（非保護候補が保護対象より高い）は負の値", () => {
    // 保護対象0.6、最有力の非保護候補0.8 ⟹ 非保護候補が1位に来る（誤爆(浅)）状況を表す。
    expect(computeProtectionMargin(0.6, 0.8)).toBeCloseTo(-0.2, 10);
  });

  it("protectedFactScore が null（保護対象が0件、または返らなかった）なら null", () => {
    expect(computeProtectionMargin(null, 0.8)).toBeNull();
  });

  it("topNonProtectedScore が null（非保護候補が1件も返らなかった）なら null", () => {
    expect(computeProtectionMargin(0.6, null)).toBeNull();
  });

  it("両方 null でも null", () => {
    expect(computeProtectionMargin(null, null)).toBeNull();
  });

  it("同点なら0（現行の intrusionMargin が0を返す境界と同じ形）", () => {
    expect(computeProtectionMargin(0.5, 0.5)).toBe(0);
  });
});

describe("computeSignedMarginStats", () => {
  it("null を除いた mean/stdDev/min/max を返す", () => {
    const stats = computeSignedMarginStats([0.2, -0.3, null, 0.1]);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBeCloseTo(0, 10);
    expect(stats.min).toBeCloseTo(-0.3, 10);
    expect(stats.max).toBeCloseTo(0.2, 10);
    expect(stats.stdDev).not.toBeNull();
  });

  it("全部 null なら count=0 で他は null", () => {
    const stats = computeSignedMarginStats([null, null]);
    expect(stats).toEqual({ count: 0, mean: null, stdDev: null, min: null, max: null });
  });

  it("1件だけなら stdDev は null（自由度 n-1 では分散を定義できない）", () => {
    const stats = computeSignedMarginStats([0.5]);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBeCloseTo(0.5, 10);
    expect(stats.stdDev).toBeNull();
    expect(stats.min).toBeCloseTo(0.5, 10);
    expect(stats.max).toBeCloseTo(0.5, 10);
  });

  it("正負が混在するとき、max が正の側・min が負の側を正しく拾う（符号が意味を持つ値のための歯）", () => {
    const stats = computeSignedMarginStats([0.9, -0.9, 0]);
    expect(stats.min).toBeCloseTo(-0.9, 10);
    expect(stats.max).toBeCloseTo(0.9, 10);
  });
});

describe("scoresMatchWithinJitter", () => {
  it("壁時計由来の下位桁の揺れ（実測で見られた1e-6〜1e-7程度）は一致とみなす", () => {
    expect(scoresMatchWithinJitter(0.8908567211186926, 0.8908563189848082)).toBe(true);
  });

  it("margin の分布（1e-2桁）に相当する差は不一致とみなす", () => {
    expect(scoresMatchWithinJitter(0.9, 0.85)).toBe(false);
  });

  it("両方 null なら一致", () => {
    expect(scoresMatchWithinJitter(null, null)).toBe(true);
  });

  it("片方だけ null なら不一致（『測れた』と『測れなかった』を同じ顔にしない）", () => {
    expect(scoresMatchWithinJitter(0.9, null)).toBe(false);
    expect(scoresMatchWithinJitter(null, 0.9)).toBe(false);
  });
});
