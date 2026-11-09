import { describe, expect, it } from "vitest";
import { diagnosticRecallLimit, predictedFirstMissDay } from "../long-horizon-bench.js";
import {
  classifyCorrectionOrder,
  classifyGoldOutcome,
  countOutcomes,
} from "../long-horizon-outcome.js";

const probeAt = new Date("2026-05-01T12:00:00.000Z");
const later = new Date("2026-06-01T00:00:00.000Z");
const earlier = new Date("2026-04-01T00:00:00.000Z");

describe("classifyGoldOutcome", () => {
  it("既定の recall() が返したなら、床もスコアも見ずに returned", () => {
    expect(
      classifyGoldOutcome({
        returnedRank: 3,
        diagnosticTotal: 0.01,
        decayFloorAt: earlier,
        probeAt,
        scoreThreshold: 0.1,
      }),
    ).toBe("returned");
  });

  it("床を過ぎていれば、スコアが閾値を越えていても decayed（忘却ゲートは段1で先に効く）", () => {
    expect(
      classifyGoldOutcome({
        returnedRank: null,
        diagnosticTotal: 0.5,
        decayFloorAt: earlier,
        probeAt,
        scoreThreshold: 0.1,
      }),
    ).toBe("decayed");
  });

  it("床がちょうど測る時刻なら decayed（ゲートを通るのは床が今より後のものだけ）", () => {
    expect(
      classifyGoldOutcome({
        returnedRank: null,
        diagnosticTotal: 0.5,
        decayFloorAt: probeAt,
        probeAt,
        scoreThreshold: 0.1,
      }),
    ).toBe("decayed");
  });

  it("床の前で、スコアが閾値未満なら below_threshold", () => {
    expect(
      classifyGoldOutcome({
        returnedRank: null,
        diagnosticTotal: 0.099,
        decayFloorAt: later,
        probeAt,
        scoreThreshold: 0.1,
      }),
    ).toBe("below_threshold");
  });

  it("床の前で、スコアが閾値以上なのに返らなければ outranked", () => {
    expect(
      classifyGoldOutcome({
        returnedRank: null,
        diagnosticTotal: 0.1,
        decayFloorAt: later,
        probeAt,
        scoreThreshold: 0.1,
      }),
    ).toBe("outranked");
  });

  it("床の前で、診断用の recall() にも上がらなければ not_reached", () => {
    expect(
      classifyGoldOutcome({
        returnedRank: null,
        diagnosticTotal: null,
        decayFloorAt: later,
        probeAt,
        scoreThreshold: 0.1,
      }),
    ).toBe("not_reached");
  });
});

describe("classifyCorrectionOrder", () => {
  it("新旧の順位関係を5つに分ける", () => {
    expect(classifyCorrectionOrder(1, 2)).toBe("new_above_old");
    expect(classifyCorrectionOrder(2, 1)).toBe("old_above_new");
    expect(classifyCorrectionOrder(1, null)).toBe("new_only");
    expect(classifyCorrectionOrder(null, 1)).toBe("old_only");
    expect(classifyCorrectionOrder(null, null)).toBe("neither");
  });
});

describe("countOutcomes", () => {
  it("種類ごとに数え、無い種類は0", () => {
    expect(countOutcomes(["returned", "returned", "decayed"])).toEqual({
      returned: 2,
      decayed: 1,
      below_threshold: 0,
      outranked: 0,
      not_reached: 0,
    });
  });
});

describe("predictedFirstMissDay（既定値からの見立て）", () => {
  it("legacy は半減期30日が実質15日になる: similarity 0.6 なら 15 × log2(6) 日", () => {
    expect(predictedFirstMissDay(0.6, "legacy")).toBeCloseTo(15 * Math.log2(6), 6);
  });

  it("eventAwareFreshness は半減期30日のまま: similarity 0.8 なら 30 × log2(8) = 90日", () => {
    expect(predictedFirstMissDay(0.8, "eventAwareFreshness")).toBeCloseTo(90, 6);
  });

  it("similarity が閾値以下なら最初から返らない", () => {
    expect(predictedFirstMissDay(0.1, "legacy")).toBe(0);
  });
});

describe("diagnosticRecallLimit", () => {
  it("その時点の記憶の総数以上にする（小さいと、順位で押し出された gold を not_reached と取り違える）", () => {
    for (const written of [1, 131, 478, 2750]) {
      expect(diagnosticRecallLimit(written)).toBeGreaterThanOrEqual(written);
    }
  });
});
