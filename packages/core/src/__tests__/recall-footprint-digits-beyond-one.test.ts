import { describe, expect, it } from "vitest";
import { estimateRecallFootprint } from "../recall-footprint.js";

/** `n >= 1e21` で `String(n)` が指数表記になっても、10進の桁数を数えることを縛る（`extraDigitsBeyondOne` は非公開なので `chars` の桁の項を通す）。 */
const chars = (memoryCountInScope: number) => estimateRecallFootprint({ memoryCountInScope }).chars;

/** 桁が1つ増えると、`totalInScope`（2回）と `eligible`（1回）で 3 字増える。 */
const PER_DIGIT = 3;

describe("estimateRecallFootprint: 桁の項は 1e21 以上でも 10 進の桁数で増える（ADR 0470）", () => {
  it("1e20 → 1e21 → 1e22 で、桁が増えるたびに 3 字ずつ増える", () => {
    expect(chars(1e21) - chars(1e20)).toBeCloseTo(PER_DIGIT, 6);
    expect(chars(1e22) - chars(1e21)).toBeCloseTo(PER_DIGIT, 6);
  });

  it("1e21 の直前の最大の double（21桁）と 1e21（22桁）で 3 字違う", () => {
    expect(chars(999999999999999868928)).toBeCloseTo(chars(1e20), 6);
    expect(chars(1e21) - chars(999999999999999868928)).toBeCloseTo(PER_DIGIT, 6);
  });

  it("1e21 未満の 21 桁どうしは同じ（9.99e20 と 1e20）", () => {
    expect(chars(9.99e20)).toBeCloseTo(chars(1e20), 6);
  });

  it("Number.MAX_SAFE_INTEGER（16桁）と 5e15（16桁）は同じ、5e16（17桁）は 3 字多い", () => {
    // 件数から 10 を引いた `eligible` も同じ桁数になる値を選ぶ（1e15 は引くと 15 桁になる）。
    expect(chars(Number.MAX_SAFE_INTEGER)).toBeCloseTo(chars(5e15), 6);
    expect(chars(5e16) - chars(5e15)).toBeCloseTo(PER_DIGIT, 6);
  });

  it("Number.MAX_VALUE（309桁）は 1e308（309桁）と同じで、1e20（21桁）より 288 桁ぶん多い", () => {
    expect(chars(Number.MAX_VALUE)).toBeCloseTo(chars(1e308), 6);
    expect(chars(Number.MAX_VALUE) - chars(1e20)).toBeCloseTo(PER_DIGIT * 288, 6);
  });

  it("陽性対照: 1e21 未満の値の結果は変わらない（5e3 → 5e4 で 3 字）", () => {
    expect(chars(5e4) - chars(5e3)).toBeCloseTo(PER_DIGIT, 6);
  });

  it("非有限の件数は今までと同じ結果で、投げない（Infinity は 4352.253、NaN は NaN）", () => {
    expect(chars(Number.POSITIVE_INFINITY)).toBeCloseTo(4352.253, 3);
    expect(Number.isNaN(chars(Number.NaN))).toBe(true);
  });
});
