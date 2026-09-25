import { describe, expect, it } from "vitest";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/**
 * ケース表（Issue #690、ADR 0300 §2）の純関数レベルの歯。
 *
 * `defaultScoringStrategy` を直接呼び、`ScoringInput.timeWeighting` を省略した場合
 * （既定・"legacy"）と `"eventAwareFreshness"` を明示した場合を比較する。
 *
 * ⛔ **このファイルが示さないもの**:
 * - `validAt`/忘却ゲートの挙動（`recall()` レベルの話。
 *   `recall-time-weighting-policy.test.ts` の管轄）。
 * - `RecallQuery.timeWeighting` が実際に `recall-runtime.ts` の3箇所へ配線されているか
 *   （同上、`recall-time-weighting-policy.test.ts` の管轄）。
 */

const HOUR_MS = 1000 * 60 * 60;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const HALF_LIFE_HOURS = 720; // 30日、docs既定

function baseInput() {
  return {
    now: NOW,
    tags: [] as string[],
    queryTags: [] as string[],
    strength: 1,
    halfLifeHours: HALF_LIFE_HOURS,
    // similarity / lexicalMatch は渡さない ⟹ affinity は中立の1に退化する
    // （同一関連度を保つための固定。ADR 0300 §2）。
  };
}

describe("defaultScoringStrategy — timeWeighting 省略時は legacy と1バイトも変わらない（既定不変の歯）", () => {
  it("occurredAt が無い記憶で、省略時と明示的な 'legacy' の score が完全一致する", () => {
    const input = {
      ...baseInput(),
      occurredAt: null,
      recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
      lastReinforcedAt: new Date(NOW.getTime() - 1 * HOUR_MS),
    };
    const omitted = defaultScoringStrategy(input);
    const explicit = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    expect(omitted).toEqual(explicit);
  });

  it("省略時は 'eventAwareFreshness' とは一致しない（⟹ 既定は新方針に倒れていない、陰性対照）", () => {
    const input = {
      ...baseInput(),
      occurredAt: null,
      recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
      lastReinforcedAt: new Date(NOW.getTime() - 1 * HOUR_MS),
    };
    const omitted = defaultScoringStrategy(input);
    const newPolicy = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(omitted.total).not.toBeCloseTo(newPolicy.total, 3);
  });
});

describe("ケース A: 恒常的な好み（occurredAt 無し）を古く記録し、最近 reinforce した（wall 時計）", () => {
  const input = {
    ...baseInput(),
    occurredAt: null,
    recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
    lastReinforcedAt: new Date(NOW.getTime() - 1 * HOUR_MS),
  };

  it("legacy: recordedAt の古さで freshness が沈み、total も沈む（ADR 0300 §1 が指摘する二重減衰）", () => {
    const score = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    expect(score.freshness).toBeLessThan(0.001);
    expect(score.total).toBeLessThan(0.001);
  });

  it("eventAwareFreshness: occurredAt が無いので freshness=1 に固定され、total は decay だけで決まる", () => {
    const score = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(score.freshness).toBe(1);
    // decay は直近 reinforce（1時間前）なのでほぼ1
    expect(score.total).toBeGreaterThan(0.99);
  });

  it("新方針は旧方針より厳密に total を持ち上げる（浮上する）", () => {
    const legacy = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    const newPolicy = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(newPolicy.total).toBeGreaterThan(legacy.total);
  });

  it("decay 自体は方針に依存しない（同じ値）", () => {
    const legacy = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    const newPolicy = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(newPolicy.decay).toBe(legacy.decay);
  });
});

describe("ケース B: 過去の出来事（occurredAt 400日前、reinforce 無し）— 陽性対照", () => {
  const occurredAt = new Date(NOW.getTime() - 400 * DAY_MS);
  const input = {
    ...baseInput(),
    occurredAt,
    recordedAt: occurredAt,
    lastReinforcedAt: null as Date | null,
  };

  it("occurredAt が在るので、legacy と eventAwareFreshness の score は完全一致する（新方針は事件を動かさない）", () => {
    const legacy = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    const newPolicy = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(newPolicy).toEqual(legacy);
  });

  it("両方針とも大きく減衰している（400日は半減期の約13.3倍）", () => {
    const legacy = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    expect(legacy.total).toBeLessThan(1e-6);
  });
});

describe("ケース C: 最近の出来事（occurredAt 1時間前）— 陽性対照", () => {
  const occurredAt = new Date(NOW.getTime() - 1 * HOUR_MS);
  const input = {
    ...baseInput(),
    occurredAt,
    recordedAt: occurredAt,
    lastReinforcedAt: null as Date | null,
  };

  it("occurredAt が在るので、legacy と eventAwareFreshness の score は完全一致する", () => {
    const legacy = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    const newPolicy = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(newPolicy).toEqual(legacy);
  });

  it("ほとんど減衰していない（total は0.99台）", () => {
    const legacy = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    expect(legacy.total).toBeGreaterThan(0.99);
  });
});

describe("ケース E: 恒常的な好み・活動時計テナント（decayClock: 'activity'）", () => {
  const input = {
    ...baseInput(),
    occurredAt: null,
    recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
    lastReinforcedAt: null as Date | null,
    decayClock: "activity" as const,
    nowSeq: 100,
    decayBaseSeq: 0,
    halfLifeRecalls: 50,
  };

  it("legacy: freshness が recordedAt の古さで沈み、total も沈む", () => {
    const score = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    expect(score.freshness).toBeLessThan(0.001);
    expect(score.decay).toBeCloseTo(0.25, 6); // 活動軸: 0.5^(100/50) = 0.25
    expect(score.total).toBeLessThan(0.001);
  });

  it("eventAwareFreshness: freshness=1、total は活動軸の decay（0.25）だけで決まる", () => {
    const score = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(score.freshness).toBe(1);
    expect(score.total).toBeCloseTo(0.25, 6);
  });

  it("⭐ 活動軸の decay は方針に依存しない（同一）——decay だけを分離して直したことの陽性対照", () => {
    const legacy = defaultScoringStrategy({ ...input, timeWeighting: "legacy" });
    const newPolicy = defaultScoringStrategy({ ...input, timeWeighting: "eventAwareFreshness" });
    expect(newPolicy.decay).toBe(legacy.decay);
    expect(newPolicy.decay).toBeCloseTo(0.25, 6);
  });
});
