import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECAY_THRESHOLD,
  decayFloorOffset,
  defaultActivityDecayStrategy,
  defaultDecayStrategy,
} from "../strategies/decay.js";

/**
 * ADR 0496（ADR 0474 材料3）: `decayFloorOffset`（と、それを通る `defaultDecayStrategy.floorAt`・
 * `defaultActivityDecayStrategy.floorAt`）は、`threshold` が有限かつ 0 超でない、`strength`・`halfLife` が有限かつ 0 以上でない
 * ときに `RangeError` で断る。以前は NaN・負・非有限がそのまま式に入り、NaN なら `floorAt` が Invalid Date を返した。
 * 内部の呼び出し（既定の閾値・検査済みの値）と、0 を使う既存の fixture は断らない。
 */

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
    // strength <= threshold で 0 を返す経路でも断る（検査は分岐の前）。
    expect(() => decayFloorOffset(0, 720, threshold)).toThrow(RangeError);
  });
  it.each(BAD_STRENGTHS)("strength=%s", (_l, strength) => {
    expect(() => decayFloorOffset(strength, 720, 0.05)).toThrow(RangeError);
    expect(() => decayFloorOffset(strength, 720, 0.05)).toThrow(/strength/);
  });
  it.each(BAD_HALF_LIVES)("halfLife=%s", (_l, halfLife) => {
    expect(() => decayFloorOffset(1, halfLife, 0.05)).toThrow(RangeError);
    expect(() => decayFloorOffset(1, halfLife, 0.05)).toThrow(/halfLife/);
    // strength <= threshold で halfLife を使わない経路でも断る。
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
    // 閾値に上限は無い（1 を超えても、strength が下回るなら 0。strength が上回るなら通常の式）。
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
    // 巨大な半減期は今までどおり表現できる最大の時刻に丸める（断らない）。
    expect(Number.isNaN(defaultDecayStrategy.floorAt(wall({ halfLifeHours: 6e8 })).getTime())).toBe(
      false,
    );
    expect(defaultActivityDecayStrategy.floorAt(activity({ halfLifeRecalls: 1e300 }))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    // halfLifeHours: 0 の「壊れた」記憶を作る fixture（recall-pipeline.test.ts など）は今までどおり作れる。
    expect(defaultDecayStrategy.floorAt(wall({ halfLifeHours: 0 })).getTime()).toBe(
      recordedAt.getTime(),
    );
  });
});
