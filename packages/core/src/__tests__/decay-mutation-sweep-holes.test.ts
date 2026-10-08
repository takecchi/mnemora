import { describe, expect, it } from "vitest";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "../strategies/decay.js";

/**
 * `strategies/decay.ts` に変異をまとめて当てたとき、どの歯も赤くならなかった形を縛る（Issue #1948）。
 */

const HOUR = 1000 * 60 * 60;
const MAX_DATE_MS = 8_640_000_000_000_000;

describe("strengthAt: now が起点より前なら strength を超える値を返す（丸めない）", () => {
  it("壁時計: 起点の1半減期前なら strength の2倍", () => {
    const recordedAt = new Date("2026-01-02T00:00:00.000Z");
    const value = defaultDecayStrategy.strengthAt(new Date(recordedAt.getTime() - 24 * HOUR), {
      recordedAt,
      lastReinforcedAt: null,
      strength: 0.5,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(1, 10);
  });

  it("活動時計: baseSeq の1半減期前なら strength の2倍", () => {
    const value = defaultActivityDecayStrategy.strengthAt(90, {
      baseSeq: 100,
      strength: 0.5,
      halfLifeRecalls: 10,
    });
    expect(value).toBeCloseTo(1, 10);
  });
});

/**
 * 上限で丸めるのは「超えるとき」だけである。既存の歯は上限ちょうど・上限を超える側と、上限から遠く離れた
 * 内側だけを見ており、上限の1つ内側の値を上限へ繰り上げる実装を見分けられなかった。
 * 下の入力は offset = 1 × log2(0.2 / 0.05) = 2（整数ちょうど）で、浮動小数の誤差が入らない。
 */
describe("floorAt: 上限の1つ内側の値は、上限へ丸めずそのまま返す", () => {
  const params = { strength: 0.2, threshold: 0.05 };

  it("活動時計: 合計が MAX_SAFE_INTEGER ちょうどならその値", () => {
    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq: Number.MAX_SAFE_INTEGER - 2, strength: params.strength, halfLifeRecalls: 1 },
      params.threshold,
    );
    expect(floor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("活動時計: 合計が MAX_SAFE_INTEGER - 1 なら MAX_SAFE_INTEGER - 1（繰り上げない）", () => {
    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq: Number.MAX_SAFE_INTEGER - 3, strength: params.strength, halfLifeRecalls: 1 },
      params.threshold,
    );
    expect(floor).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it("壁時計: 合計が Date の最大値ちょうどならその値", () => {
    const floor = defaultDecayStrategy.floorAt(
      {
        recordedAt: new Date(MAX_DATE_MS - 2 * HOUR),
        lastReinforcedAt: null,
        strength: params.strength,
        halfLifeHours: 1,
      },
      params.threshold,
    );
    expect(floor.getTime()).toBe(MAX_DATE_MS);
  });

  it("壁時計: 合計が Date の最大値 - 1ms なら最大値 - 1ms（繰り上げない）", () => {
    const floor = defaultDecayStrategy.floorAt(
      {
        recordedAt: new Date(MAX_DATE_MS - 2 * HOUR - 1),
        lastReinforcedAt: null,
        strength: params.strength,
        halfLifeHours: 1,
      },
      params.threshold,
    );
    expect(floor.getTime()).toBe(MAX_DATE_MS - 1);
  });
});
