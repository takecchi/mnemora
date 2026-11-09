import { describe, expect, it } from "vitest";
import type { LongHorizonProbeRecord, LongHorizonReport } from "../long-horizon-bench.js";
import { LONG_HORIZON_FACTS } from "../long-horizon-case-set.js";
import { buildPredictionRows, formatMedianRank } from "../long-horizon-format.js";
import type { GoldOutcomeKind } from "../long-horizon-outcome.js";

const dormant = LONG_HORIZON_FACTS.find((f) => f.factClass === "dormant")!;

function probe(
  arm: "A" | "B",
  day: number,
  outcome: GoldOutcomeKind,
  similarity = 0.9,
): LongHorizonProbeRecord {
  return {
    arm,
    checkpointDay: day,
    factId: dormant.id,
    factClass: "dormant",
    role: "gold",
    outcome,
    returnedRank: outcome === "returned" ? 1 : null,
    retrievedVia: outcome === "returned" ? "ann" : null,
    diagnostic: {
      rank: 1,
      total: 0.5,
      similarity,
      lexicalMatch: null,
      decay: 1,
      freshness: 1,
      tagMatch: 1,
      strength: 1,
    },
    decayFloorAt: "2026-06-01T00:00:00.000Z",
    lastReinforcedAt: null,
  };
}

function reportOf(probes: LongHorizonProbeRecord[], arms: ("A" | "B")[]): LongHorizonReport {
  return {
    facts: [dormant],
    days: 180,
    fillersPerDay: 1,
    checkpointDays: [7, 30, 60],
    arms,
    memoriesWritten: 0,
    probes,
    quantities: [],
    usageReports: { A: 0, B: 0, C: 0, D: 0 },
  };
}

describe("buildPredictionRows", () => {
  it("見立てと比べる欄は閾値割れ・忘却ゲートで最初に落ちた時点で、順位で先に負けた時点とは分ける", () => {
    const rows = buildPredictionRows(
      reportOf(
        [probe("A", 7, "returned"), probe("A", 30, "outranked"), probe("A", 60, "below_threshold")],
        ["A"],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      observedFirstMissCheckpoint: 30,
      observedFirstMissOutcome: "outranked",
      observedFirstThresholdOrDecayCheckpoint: 60,
      similarityAtFirstCheckpoint: 0.9,
    });
    expect(rows[0]!.predictedFirstMissDay).toBeCloseTo(15 * Math.log2(9), 6);
  });

  it("使用報告ありの arm は見立ての対象にしない（式が使用報告による強化を入れていない）", () => {
    const rows = buildPredictionRows(reportOf([probe("B", 7, "returned")], ["B"]));
    expect(rows).toEqual([]);
  });
});

describe("formatMedianRank", () => {
  it("中央値を出し、候補に上がらなかったもの（null）は最下位より後ろに置く", () => {
    expect(formatMedianRank([5, 1, 3])).toBe("3");
    expect(formatMedianRank([1, null, null])).toBe("—");
  });
});
