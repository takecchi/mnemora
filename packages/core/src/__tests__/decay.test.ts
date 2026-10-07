import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECAY_THRESHOLD,
  decayFactor,
  decayFloorOffset,
  defaultActivityDecayStrategy,
  defaultDecayStrategy,
} from "../strategies/decay.js";

const HOUR = 1000 * 60 * 60;

describe("defaultDecayStrategy.strengthAt", () => {
  it("elapsed=0 のとき strength をそのまま返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const value = defaultDecayStrategy.strengthAt(recordedAt, {
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(1, 10);
  });

  it("1 half-life 経過で半分になる（recordedAt を起点にする分岐）", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(recordedAt.getTime() + 24 * HOUR);
    const value = defaultDecayStrategy.strengthAt(now, {
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(0.5, 10);
  });

  it("lastReinforcedAt があればそちらを起点にする（recordedAt を起点にしない）", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const lastReinforcedAt = new Date(recordedAt.getTime() + 12 * HOUR);
    const now = new Date(recordedAt.getTime() + 24 * HOUR);
    // recordedAt を起点にすれば elapsed=24h -> 0.5 になるはずだが、
    // lastReinforcedAt(recordedAt+12h) を起点にすると elapsed=12h -> 0.5^(0.5) になる。
    const value = defaultDecayStrategy.strengthAt(now, {
      recordedAt,
      lastReinforcedAt,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(Math.pow(0.5, 0.5), 10);
    expect(value).not.toBeCloseTo(0.5, 5);
  });

  it("strength が 1 以外でも比例して掛かる", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(recordedAt.getTime() + 24 * HOUR);
    const value = defaultDecayStrategy.strengthAt(now, {
      recordedAt,
      lastReinforcedAt: null,
      strength: 2,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(1, 10);
  });
});

describe("defaultDecayStrategy.floorAt", () => {
  it("strength > threshold: base + halfLifeHours * log2(strength/threshold) 時間後を返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 24 },
      0.5,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime() + 24 * HOUR);
  });

  it("strength <= threshold（既に閾値以下）: base をそのまま返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 0.05, halfLifeHours: 24 },
      0.05,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime());
  });

  it("strength < threshold（既に大きく下回っている）でも base をそのまま返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 0.01, halfLifeHours: 24 },
      0.05,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime());
  });

  it("threshold を省略すると既定値 DEFAULT_DECAY_THRESHOLD (0.05) が使われる", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const withDefault = defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    const withExplicit = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 24 },
      DEFAULT_DECAY_THRESHOLD,
    );
    expect(withDefault.getTime()).toBe(withExplicit.getTime());
  });

  it("lastReinforcedAt があればそちらを起点にする", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const lastReinforcedAt = new Date(recordedAt.getTime() + 5 * HOUR);
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt, strength: 1, halfLifeHours: 10 },
      0.5,
    );
    expect(floor.getTime()).toBe(lastReinforcedAt.getTime() + 10 * HOUR);
  });

  it("halfLifeHours が有限でも巨大だと Invalid Date にせず、表現可能な最大の Date に丸める", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 6e8, // 6億時間。ADR 0125 の値域 (0, ∞) の内側（Infinity ではない）
    });
    expect(Number.isNaN(floor.getTime())).toBe(false);
    expect(floor.getTime()).toBe(8_640_000_000_000_000);
    // 丸めた後も「recordedAt より先の未来」であることは保たれる——
    // wallAxisAlive（`decayFloorAt > now`）が「まだ生きている」側に倒れるために必要。
    expect(floor.getTime()).toBeGreaterThan(recordedAt.getTime());
  });

  it("halfLifeHours が表現可能域に収まる大きさなら、丸めずにそのまま計算する（回帰）", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 24 },
      0.5,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime() + 24 * HOUR);
    expect(floor.getTime()).toBeLessThan(8_640_000_000_000_000);
  });

  // 丸めの判定は「起点 + 経過」の合計に掛かる。経過だけを見て丸めると、起点が
  // 表現可能域の端に近いときに Invalid Date を返してしまう。
  it("起点が表現可能域の端に近く、経過は小さくても、合計が最大値を超えるなら最大の Date に丸める", () => {
    const recordedAt = new Date(8_640_000_000_000_000 - HOUR);
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 24 },
      0.5,
    );
    expect(Number.isNaN(floor.getTime())).toBe(false);
    expect(floor.getTime()).toBe(8_640_000_000_000_000);
  });

  it("合計が最大値より小さい巨大な半減期は、丸めずにそのまま計算する", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 1e9 },
      0.5,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime() + 1e9 * HOUR);
    expect(floor.getTime()).toBeLessThan(8_640_000_000_000_000);
  });

  it("1970 年より前の起点は、下側へ丸めずにそのまま計算する", () => {
    const recordedAt = new Date("1900-01-01T00:00:00.000Z");
    expect(recordedAt.getTime()).toBeLessThan(0);
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 24 },
      0.5,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime() + 24 * HOUR);
    const alreadyBelow = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 0.05, halfLifeHours: 24 },
      0.05,
    );
    expect(alreadyBelow.getTime()).toBe(recordedAt.getTime());
  });
});

/** 直前の「threshold を省略すると既定値が使われる」テストは両辺で `DEFAULT_DECAY_THRESHOLD` を使うので、既定値そのものが変わっても赤くならない。既定値を数値で釘付けにするのはこの2本。 */
describe("DEFAULT_DECAY_THRESHOLD（ADR 0010 が固定する値）", () => {
  it("既定の閾値は 0.05 である", () => {
    expect(DEFAULT_DECAY_THRESHOLD).toBe(0.05);
  });

  it("threshold 省略時の floorAt が 0.05 由来の絶対時刻になる", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    const expectedHours = 24 * Math.log2(20);
    // Date はミリ秒未満を切り捨てるので 1ms の許容で比べる
    expect(floor.getTime()).toBeCloseTo(recordedAt.getTime() + expectedHours * HOUR, -1);
  });
});

/** 単位を持たない数値核（`decayFactor`/`decayFloorOffset`）そのものの歯。`defaultDecayStrategy`・`defaultActivityDecayStrategy` はどちらもこの2関数の薄い包みなので、核が壊れれば両方の時計が同時に壊れる。 */
describe("decayFactor（単位を持たない核、ADR 0165 決めたこと7）", () => {
  it("elapsed=0 のとき常に1", () => {
    expect(decayFactor(0, 24)).toBe(1);
  });

  it("elapsed=halfLife のとき常に0.5", () => {
    expect(decayFactor(24, 24)).toBeCloseTo(0.5, 10);
  });

  it("elapsed=2*halfLife のとき常に0.25（単位に依らない——時間でも recall 回数でも同じ式）", () => {
    expect(decayFactor(48, 24)).toBeCloseTo(0.25, 10);
    expect(decayFactor(10, 5)).toBeCloseTo(0.25, 10);
  });
});

describe("decayFloorOffset（単位を持たない核、ADR 0165 決めたこと7）", () => {
  it("strength <= threshold のとき 0 を返す（既に閾値以下）", () => {
    expect(decayFloorOffset(0.05, 24, 0.05)).toBe(0);
    expect(decayFloorOffset(0.01, 24, 0.05)).toBe(0);
  });

  it("strength > threshold のとき halfLife * log2(strength/threshold) を返す", () => {
    expect(decayFloorOffset(1, 24, 0.5)).toBeCloseTo(24, 10);
    expect(decayFloorOffset(1, 10, 0.05)).toBeCloseTo(10 * Math.log2(20), 10);
  });
});

describe("defaultActivityDecayStrategy.strengthAt", () => {
  it("elapsed=0 のとき strength をそのまま返す", () => {
    const value = defaultActivityDecayStrategy.strengthAt(100, {
      baseSeq: 100,
      strength: 1,
      halfLifeRecalls: 10,
    });
    expect(value).toBeCloseTo(1, 10);
  });

  it("1 half-life（recall 回数）経過で半分になる", () => {
    const value = defaultActivityDecayStrategy.strengthAt(110, {
      baseSeq: 100,
      strength: 1,
      halfLifeRecalls: 10,
    });
    expect(value).toBeCloseTo(0.5, 10);
  });

  it("strength が 1 以外でも比例して掛かる", () => {
    const value = defaultActivityDecayStrategy.strengthAt(110, {
      baseSeq: 100,
      strength: 2,
      halfLifeRecalls: 10,
    });
    expect(value).toBeCloseTo(1, 10);
  });
});

describe("defaultActivityDecayStrategy.floorAt", () => {
  it("strength <= threshold（既に閾値以下）: baseSeq をそのまま返す", () => {
    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq: 100, strength: 0.05, halfLifeRecalls: 10 },
      0.05,
    );
    expect(floor).toBe(100);
  });

  it("threshold を省略すると既定値 DEFAULT_DECAY_THRESHOLD (0.05) が使われる", () => {
    const withDefault = defaultActivityDecayStrategy.floorAt({
      baseSeq: 0,
      strength: 1,
      halfLifeRecalls: 10,
    });
    const withExplicit = defaultActivityDecayStrategy.floorAt(
      { baseSeq: 0, strength: 1, halfLifeRecalls: 10 },
      DEFAULT_DECAY_THRESHOLD,
    );
    expect(withDefault).toBe(withExplicit);
  });

  /**
   * offset = 3 * log2(1/0.6) ≈ 2.2109 が整数でない入力で、ceil の境界を測る（`activityFloorAt` の doc が警告する壊れ方）。
   * `Math.floor` の実装だと floor=baseSeq+2 になり、まだ閾値を上回っている（strengthAt(+2) ≈ 0.63 > 0.6）Memory が忘却ゲートを通ってしまう。
   */
  it("offset が非整数のとき ceil する（floor にすると閾値をまだ上回っている seq が忘却ゲートを通ってしまう）", () => {
    const baseSeq = 100;
    const halfLifeRecalls = 3;
    const threshold = 0.6;
    const offset = decayFloorOffset(1, halfLifeRecalls, threshold);
    expect(offset).not.toBe(Math.trunc(offset)); // 非整数であることの前提を確認する

    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq, strength: 1, halfLifeRecalls },
      threshold,
    );
    expect(floor).toBe(baseSeq + Math.ceil(offset));
    expect(floor).toBe(103); // ceil(2.2109...) = 3

    const strengthAtFloorMinusOne = defaultActivityDecayStrategy.strengthAt(floor - 1, {
      baseSeq,
      strength: 1,
      halfLifeRecalls,
    });
    expect(strengthAtFloorMinusOne).toBeGreaterThan(threshold);

    const strengthAtFloor = defaultActivityDecayStrategy.strengthAt(floor, {
      baseSeq,
      strength: 1,
      halfLifeRecalls,
    });
    expect(strengthAtFloor).toBeLessThanOrEqual(threshold);
  });

  it("halfLifeRecalls が有限でも巨大だと、Number.MAX_SAFE_INTEGER を超えず丸める", () => {
    const floor = defaultActivityDecayStrategy.floorAt({
      baseSeq: 1000,
      strength: 1,
      halfLifeRecalls: 1e16, // ADR 0165 の値域 (0, ∞) の内側（Infinity ではない）
    });
    expect(Number.isSafeInteger(floor)).toBe(true);
    expect(floor).toBe(Number.MAX_SAFE_INTEGER);
    expect(floor).toBeGreaterThan(1000);
  });

  it("halfLifeRecalls が安全整数域に収まる大きさなら、丸めずにそのまま計算する（回帰）", () => {
    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq: 100, strength: 1, halfLifeRecalls: 10 },
      0.5,
    );
    expect(floor).toBe(110); // 既存の「1 half-life 経過で半分になる」ケースと同じ入力
    expect(floor).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  // 丸めの判定は「起点 + 経過」の合計に掛かる。経過だけを見て丸めると、起点が
  // 安全整数の端に近いときに、精度の無い値を返してしまう。
  it("baseSeq が安全整数の端に近く、経過は小さくても、合計が上限を超えるなら Number.MAX_SAFE_INTEGER に丸める", () => {
    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq: Number.MAX_SAFE_INTEGER - 1, strength: 1, halfLifeRecalls: 10 },
      0.5,
    );
    expect(floor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("合計が安全整数の中に収まる巨大な半減期は、丸めずにそのまま計算する", () => {
    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq: 7, strength: 1, halfLifeRecalls: 2 ** 45 },
      0.5,
    );
    expect(floor).toBe(7 + 2 ** 45);
  });
});
