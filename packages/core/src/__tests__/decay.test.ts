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
    // threshold を strength の半分にすると log2(2) = 1 になり、
    // floorAt はちょうど base + halfLifeHours 時間後になる（検算しやすいケース）。
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

  /**
   * バグ調査で見つけた穴（ADR 0125 未収録）: `halfLifeHours` は ADR 0125 決定4 が
   * `(0, ∞)` の有限の正の実数を認めている——`Infinity` だけを弾く。だが
   * `base + halfLifeHours * log2(strength/threshold)` は、有限でも十分大きい
   * `halfLifeHours`（例: 6億時間 ≈ 68,000年、`Infinity` ではない）で
   * `new Date` の表現可能域（`±8.64e15ms`、西暦 ±275760年）を超え、修正前は
   * Invalid Date を返していた（`node` で実測: `halfLifeHours: 6e8` で
   * `Invalid Date`）。**Invalid Date になると壊れ方が特に悪い**——
   * `decayFloorAt > now` は NaN の比較で常に `false` になり、
   * `recall-runtime.ts` の `wallAxisAlive` が「作成直後から既に忘却済み」と
   * 誤判定する。意図（「ほぼ永久に減衰しない」）とちょうど逆に壊れる。
   */
  it("halfLifeHours が有限でも巨大だと Invalid Date にせず、表現可能な最大の Date に丸める", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 6e8, // 6億時間。ADR 0125 の値域 (0, ∞) の内側（Infinity ではない）
    });
    expect(Number.isNaN(floor.getTime())).toBe(false);
    // Date が表現できる最大値（ECMA-262、西暦 +275760 年ごろ）に丸まる。
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
    // 通常域では丸めの影響を受けない（既存の1本目のケースと同じ検算）。
    expect(floor.getTime()).toBe(recordedAt.getTime() + 24 * HOUR);
    expect(floor.getTime()).toBeLessThan(8_640_000_000_000_000);
  });
});

/**
 * ADR 0010 は既定の減衰閾値を 0.05 に固定している。この値は Phase 1 で
 * `decay_floor_at` として実際に書き込まれ、Phase 2 で「いつ検索から外れるか」を決める。
 *
 * 直前の「threshold を省略すると既定値が使われる」テストは、両辺で
 * `DEFAULT_DECAY_THRESHOLD` を使っているため**既定値そのものが変わっても赤くならない**。
 * 既定値を数値で釘付けにするのはこの2本である。
 */
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
    // 24h * log2(1 / 0.05) = 24 * log2(20) ≈ 103.6987 時間後
    const expectedHours = 24 * Math.log2(20);
    // Date はミリ秒未満を切り捨てるので 1ms の許容で比べる
    expect(floor.getTime()).toBeCloseTo(recordedAt.getTime() + expectedHours * HOUR, -1);
  });
});

/**
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと7:
 * 単位を持たない数値核（`decayFactor`/`decayFloorOffset`）そのものの歯。
 *
 * `defaultDecayStrategy`（壁時計）と `defaultActivityDecayStrategy`（活動時計）は
 * どちらもこの2関数の薄い包みである——**この2関数が壊れれば両方の時計が同時に壊れる**。
 * 上の「defaultDecayStrategy.strengthAt/floorAt」の歯は数値をリテラルで固定しているので、
 * `strengthAt`/`floorAt` の実装をこの核へ書き換えても（ADR 0165 が実際に行った変更）
 * 出力が1つも変わっていないことは、既存の歯がそのまま回帰の歯になっている。
 * ここではさらに核そのものの性質を直接固定する。
 */
describe("decayFactor（単位を持たない核、ADR 0165 決めたこと7）", () => {
  it("elapsed=0 のとき常に1", () => {
    expect(decayFactor(0, 24)).toBe(1);
  });

  it("elapsed=halfLife のとき常に0.5", () => {
    expect(decayFactor(24, 24)).toBeCloseTo(0.5, 10);
  });

  it("elapsed=2*halfLife のとき常に0.25（単位に依らない——時間でも recall 回数でも同じ式）", () => {
    expect(decayFactor(48, 24)).toBeCloseTo(0.25, 10);
    // 単位を「回数」として読んでも式は同じ（ADR 0165 決めたこと7の主張そのもの）。
    expect(decayFactor(10, 5)).toBeCloseTo(0.25, 10);
  });
});

describe("decayFloorOffset（単位を持たない核、ADR 0165 決めたこと7）", () => {
  it("strength <= threshold のとき 0 を返す（既に閾値以下）", () => {
    expect(decayFloorOffset(0.05, 24, 0.05)).toBe(0);
    expect(decayFloorOffset(0.01, 24, 0.05)).toBe(0);
  });

  it("strength > threshold のとき halfLife * log2(strength/threshold) を返す", () => {
    // threshold を strength の半分にすると log2(2)=1 になり、offset はちょうど halfLife。
    expect(decayFloorOffset(1, 24, 0.5)).toBeCloseTo(24, 10);
    expect(decayFloorOffset(1, 10, 0.05)).toBeCloseTo(10 * Math.log2(20), 10);
  });
});

/**
 * `defaultActivityDecayStrategy` — 壁時計と同じ式を「recall() が起きた回数」の単位で
 * 読む実例（ADR 0165 決めたこと1・3・7）。
 */
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
   * ⭐ ceil の境界（`strategies/decay.ts` の `activityFloorAt` doc コメントが名指しした歯）。
   *
   * strength=1, halfLifeRecalls=3, threshold=0.6 のとき
   * offset = 3 * log2(1/0.6) ≈ 2.2109 — 整数ではない。
   *
   * - `Math.floor` を使う実装なら floor=baseSeq+2 になり、nowSeq=baseSeq+2 で
   *   `decay_floor_seq(=+2) > nowSeq(=+2)` が false になって**まだ閾値を上回っている**
   *   （strengthAt(+2) ≈ 0.63 > 0.6）Memory が忘却ゲートを通ってしまう——これが
   *   `activityFloorAt` の doc コメントが警告する壊れ方そのもの。
   * - `Math.ceil` なら floor=baseSeq+3 になり、`nowSeq=+2` ではまだ `floor(+3) > +2` で
   *   生き残る（正しい）。`nowSeq=+3` で初めて `floor(+3) > +3` が false になり、
   *   その時点の実際の強度 strengthAt(+3)=0.5 は既に threshold(0.6) を下回っている
   *   ——沈める判定が「実際に閾値を割った後」にしか起きない。
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

    // 変異試験の反証: floor にすると 102 になり、下のアサーションが赤くなる
    // （`Math.floor` へ書き換えると 102 !== 103 で落ちることを別途手元で確認した）。
    const strengthAtFloorMinusOne = defaultActivityDecayStrategy.strengthAt(floor - 1, {
      baseSeq,
      strength: 1,
      halfLifeRecalls,
    });
    // floor の1つ手前（=102、Math.floor 実装なら「これが floor」になってしまう seq）は
    // まだ閾値を上回っている——ここで沈めてはならないことの検算。
    expect(strengthAtFloorMinusOne).toBeGreaterThan(threshold);

    const strengthAtFloor = defaultActivityDecayStrategy.strengthAt(floor, {
      baseSeq,
      strength: 1,
      halfLifeRecalls,
    });
    // floor 自身では、実際の強度が既に閾値以下になっている（ceil が正しい側に倒れている）。
    expect(strengthAtFloor).toBeLessThanOrEqual(threshold);
  });

  /**
   * バグ調査で見つけた穴: `halfLifeRecalls` は `isHalfLifeRecallsInRange`（`(0, ∞)`、
   * `Infinity` のみ拒む）の値域を持ち、有限だが巨大な値を許す。修正前は
   * `baseSeq + Math.ceil(offset)` をそのまま返しており、`Number.MAX_SAFE_INTEGER`
   * （`2**53-1`）を超える値を静かに返していた——戻り値は Postgres の `bigint` 列
   * （`decay_floor_seq`）に `mode: "number"` で書き込まれるため、安全整数域を
   * 超えると精度を落とした値を書く（node で実測: `halfLifeRecalls: 1e16` で
   * `Number.isSafeInteger` が `false` の値を返していた）。
   */
  it("halfLifeRecalls が有限でも巨大だと、Number.MAX_SAFE_INTEGER を超えず丸める", () => {
    const floor = defaultActivityDecayStrategy.floorAt({
      baseSeq: 1000,
      strength: 1,
      halfLifeRecalls: 1e16, // ADR 0165 の値域 (0, ∞) の内側（Infinity ではない）
    });
    expect(Number.isSafeInteger(floor)).toBe(true);
    expect(floor).toBe(Number.MAX_SAFE_INTEGER);
    // 丸めた後も baseSeq より先（＝まだ生きている側）であることは保たれる。
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
});
