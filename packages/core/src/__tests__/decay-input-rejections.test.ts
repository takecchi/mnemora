import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECAY_THRESHOLD,
  decayFloorOffset,
  defaultActivityDecayStrategy,
  defaultDecayStrategy,
} from "../strategies/decay.js";

const recordedAt = new Date("2026-01-01T00:00:00.000Z");
const wall = (over: { strength?: number; halfLifeHours?: number } = {}) => ({
  recordedAt,
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
  ...over,
});
const activity = (over: { strength?: number; halfLifeRecalls?: number } = {}) => ({
  baseSeq: 10,
  strength: 1,
  halfLifeRecalls: 100,
  ...over,
});

const BAD_THRESHOLDS: Array<[string, number]> = [
  ["0", 0],
  ["-0", -0],
  ["負", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
];
const BAD_STRENGTHS: Array<[string, number]> = [
  ["負", -0.1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
];
const BAD_HALF_LIVES: Array<[string, number]> = [
  ["負", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
];

describe("decayFloorOffset: 壊れた入力は RangeError", () => {
  it.each(BAD_THRESHOLDS)("threshold=%s", (_l, threshold) => {
    expect(() => decayFloorOffset(1, 720, threshold)).toThrow(RangeError);
    expect(() => decayFloorOffset(1, 720, threshold)).toThrow(/threshold/);
    expect(() => decayFloorOffset(0, 720, threshold)).toThrow(RangeError);
  });
  it.each(BAD_STRENGTHS)("strength=%s", (_l, strength) => {
    expect(() => decayFloorOffset(strength, 720, 0.05)).toThrow(RangeError);
    expect(() => decayFloorOffset(strength, 720, 0.05)).toThrow(/strength/);
  });
  it.each(BAD_HALF_LIVES)("halfLife=%s", (_l, halfLife) => {
    expect(() => decayFloorOffset(1, halfLife, 0.05)).toThrow(RangeError);
    expect(() => decayFloorOffset(1, halfLife, 0.05)).toThrow(/halfLife/);
    expect(() => decayFloorOffset(0.01, halfLife, 0.05)).toThrow(RangeError);
  });

  it("陽性対照（やりすぎを弾く）: 今までの値は同じ結果。0 は断らない", () => {
    expect(decayFloorOffset(1, 720, 0.05)).toBeCloseTo(720 * Math.log2(20), 10);
    expect(decayFloorOffset(0.05, 720, 0.05)).toBe(0);
    expect(decayFloorOffset(0, 720, 0.05)).toBe(0);
    expect(decayFloorOffset(1, 0, 0.05)).toBe(0);
    expect(decayFloorOffset(1, 1e-320, 0.05)).toBeGreaterThanOrEqual(0);
    expect(decayFloorOffset(1e300, 720, 5e-324)).toBeGreaterThan(0);
    expect(decayFloorOffset(2, 24, 0.5)).toBeCloseTo(48, 10);
    expect(decayFloorOffset(1, 24, 2)).toBe(0);
    expect(decayFloorOffset(1, 24, 1e300)).toBe(0);
    expect(decayFloorOffset(8, 24, 2)).toBeCloseTo(48, 10);
  });
});

describe("floorAt（壁時計・活動時計）も同じ検査を通る", () => {
  it.each(BAD_THRESHOLDS)("壁時計 threshold=%s", (_l, threshold) => {
    expect(() => defaultDecayStrategy.floorAt(wall(), threshold)).toThrow(RangeError);
  });
  it.each(BAD_STRENGTHS)("壁時計 strength=%s", (_l, strength) => {
    expect(() => defaultDecayStrategy.floorAt(wall({ strength }))).toThrow(RangeError);
  });
  it.each(BAD_HALF_LIVES)("壁時計 halfLifeHours=%s", (_l, halfLifeHours) => {
    expect(() => defaultDecayStrategy.floorAt(wall({ halfLifeHours }))).toThrow(RangeError);
  });
  it.each(BAD_THRESHOLDS)("活動時計 threshold=%s", (_l, threshold) => {
    expect(() => defaultActivityDecayStrategy.floorAt(activity(), threshold)).toThrow(RangeError);
  });
  it.each(BAD_STRENGTHS)("活動時計 strength=%s", (_l, strength) => {
    expect(() => defaultActivityDecayStrategy.floorAt(activity({ strength }))).toThrow(RangeError);
  });
  it.each(BAD_HALF_LIVES)("活動時計 halfLifeRecalls=%s", (_l, halfLifeRecalls) => {
    expect(() => defaultActivityDecayStrategy.floorAt(activity({ halfLifeRecalls }))).toThrow(
      RangeError,
    );
  });

  it("陽性対照: 内部の呼び出し（strength 1・既定の閾値・検査済みの半減期）は今までの値を返す", () => {
    const floor = defaultDecayStrategy.floorAt(wall());
    expect(floor.getTime()).toBe(
      new Date(
        recordedAt.getTime() + 720 * Math.log2(1 / DEFAULT_DECAY_THRESHOLD) * 3_600_000,
      ).getTime(),
    );
    expect(defaultActivityDecayStrategy.floorAt(activity())).toBe(
      10 + Math.ceil(100 * Math.log2(1 / DEFAULT_DECAY_THRESHOLD)),
    );
    expect(Number.isNaN(defaultDecayStrategy.floorAt(wall({ halfLifeHours: 6e8 })).getTime())).toBe(
      false,
    );
    expect(defaultActivityDecayStrategy.floorAt(activity({ halfLifeRecalls: 1e300 }))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(defaultDecayStrategy.floorAt(wall({ halfLifeHours: 0 })).getTime()).toBe(
      recordedAt.getTime(),
    );
  });
});
