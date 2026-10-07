import { describe, expect, it } from "vitest";
import { isHalfLifeHoursInRange } from "../index.js";

describe("isHalfLifeHoursInRange は (0, ∞) の有限の正の実数だけを通す", () => {
  it.each([
    ["ちょうど 0", 0],
    ["負の 0", -0],
    ["負", -1],
    ["負の無限大", Number.NEGATIVE_INFINITY],
    ["正の無限大", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("%s は値域の外", (_label, value) => {
    expect(isHalfLifeHoursInRange(value)).toBe(false);
  });

  it.each([
    ["既定の 720", 720],
    ["1", 1],
    ["1 未満の小数", 0.5],
    ["float64 で表せる最小の正の値", Number.MIN_VALUE],
    ["有限の大きい値（上限は無い）", 1e300],
  ])("%s は値域の内", (_label, value) => {
    expect(isHalfLifeHoursInRange(value)).toBe(true);
  });
});
