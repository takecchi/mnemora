import { describe, expect, it } from "vitest";
import {
  computeIntrusionMargin,
  computeProtectionMargin,
  maxNonProtectedScore,
} from "../correction-candidate-arm.js";

describe("computeProtectionMargin", () => {
  it("深い誤爆側（保護対象が最有力の非保護候補より高い）は正の値", () => {
    expect(computeProtectionMargin(0.9, 0.7)).toBeCloseTo(0.2, 10);
  });

  it("誤爆(浅)側（非保護候補が保護対象より高い）は負の値", () => {
    expect(computeProtectionMargin(0.6, 0.8)).toBeCloseTo(-0.2, 10);
  });

  it("protectedFactScore が null（保護対象が0件・棄権）なら null", () => {
    expect(computeProtectionMargin(null, 0.8)).toBeNull();
  });

  it("topNonProtectedScore が null（非保護候補が1件も返らなかった）なら null", () => {
    expect(computeProtectionMargin(0.6, null)).toBeNull();
  });

  it("両方 null でも null", () => {
    expect(computeProtectionMargin(null, null)).toBeNull();
  });

  it("同点なら0", () => {
    expect(computeProtectionMargin(0.5, 0.5)).toBe(0);
  });
});

describe("maxNonProtectedScore", () => {
  it("protectedIds に含まれない候補のうち最大スコアを返す", () => {
    const memories = [{ score: { total: 0.9 } }, { score: { total: 0.5 } }];
    const externalIds = ["protected", "intruder"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeCloseTo(0.5, 10);
  });

  it("複数の非保護候補があれば最大を選ぶ", () => {
    const memories = [
      { score: { total: 0.9 } },
      { score: { total: 0.5 } },
      { score: { total: 0.7 } },
    ];
    const externalIds = ["protected", "intruder-weak", "intruder-strong"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeCloseTo(0.7, 10);
  });

  it("全件が保護対象なら null", () => {
    const memories = [{ score: { total: 0.9 } }];
    const externalIds = ["protected"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeNull();
  });

  it("空配列なら null", () => {
    expect(maxNonProtectedScore([], [], ["a"])).toBeNull();
  });
});

describe("computeIntrusionMargin は変わっていない", () => {
  it("深い誤爆のとき topScore - protectedFactScore を返す", () => {
    expect(computeIntrusionMargin(0.9, true, 0.7)).toBeCloseTo(0.2, 10);
  });

  it("protectedFacts が1件だけの深い誤爆では0になる", () => {
    expect(computeIntrusionMargin(0.85, true, 0.85)).toBe(0);
  });

  it("誤爆(浅)のときは null（protectionMargin は同じ入力で非nullになる、という対比）", () => {
    expect(computeIntrusionMargin(0.9, false, 0.7)).toBeNull();
    expect(computeProtectionMargin(0.7, 0.9)).toBeCloseTo(-0.2, 10);
  });
});
