import { describe, expect, it } from "vitest";
import { resolveConcurrency } from "../tick-driver.js";

describe("resolveConcurrency", () => {
  it("省略時は1", () => {
    expect(resolveConcurrency(undefined)).toBe(1);
  });

  it("正の整数はそのまま返す", () => {
    expect(resolveConcurrency(1)).toBe(1);
    expect(resolveConcurrency(4)).toBe(4);
  });

  it("0以下は投げる", () => {
    expect(() => resolveConcurrency(0)).toThrow(/positive integer/);
    expect(() => resolveConcurrency(-1)).toThrow(/positive integer/);
  });

  it("整数でなければ投げる", () => {
    expect(() => resolveConcurrency(1.5)).toThrow(/positive integer/);
  });

  it("⭐ 数でなければ TypeError（RangeError ではない）", () => {
    for (const value of ["2", null, 2n, {}]) {
      const call = () => resolveConcurrency(value as unknown as number);
      expect(call).toThrow(TypeError);
      expect(call).not.toThrow(RangeError);
    }
  });

  it("⭐ 数だが 1 以上の整数でなければ RangeError（TypeError ではない）", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
      const call = () => resolveConcurrency(value);
      expect(call).toThrow(RangeError);
      expect(call).not.toThrow(TypeError);
    }
  });

  it("⭐ 型を変えても message は変わらない", () => {
    expect(() => resolveConcurrency("2" as unknown as number)).toThrow(
      "createBullmqTickDriver: concurrency must be a positive integer, got 2",
    );
    expect(() => resolveConcurrency(1.5)).toThrow(
      "createBullmqTickDriver: concurrency must be a positive integer, got 1.5",
    );
  });
});
