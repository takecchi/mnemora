import { describe, expect, it } from "vitest";
import type { AffinityUnmeasuredScore, ScoreBreakdown } from "@mnemora/core";
import {
  assertAffinityMeasured,
  isAffinityMeasured,
  requireMeasuredTotal,
  scoreTotalOrNull,
} from "../recalled-score.js";

const measured: ScoreBreakdown = {
  similarity: 0.5,
  decay: 1,
  tagMatch: 1,
  freshness: 1,
  strength: 1,
  total: 0.42,
};

const unmeasured: AffinityUnmeasuredScore = {
  affinityMeasured: false,
  decay: 1,
  tagMatch: 1,
  freshness: 1,
  strength: 1,
};

describe("recalled-score（ベンチ・デモが RecalledScore の union を読むヘルパー）", () => {
  it("isAffinityMeasured: affinityMeasured が false のときだけ偽。欄が無い（旧形）・true は真", () => {
    expect(isAffinityMeasured(unmeasured)).toBe(false);
    expect(isAffinityMeasured(measured)).toBe(true);
    expect(isAffinityMeasured({ ...measured, affinityMeasured: true })).toBe(true);
  });

  it("scoreTotalOrNull: 測っているなら total、測っていないなら null（0 や NaN に倒さない）", () => {
    expect(scoreTotalOrNull(measured)).toBe(0.42);
    expect(scoreTotalOrNull({ ...measured, total: 0 })).toBe(0);
    expect(scoreTotalOrNull(unmeasured)).toBeNull();
  });

  it("requireMeasuredTotal: 測っているなら total を返す", () => {
    expect(requireMeasuredTotal(measured)).toBe(0.42);
  });

  it("requireMeasuredTotal: affinityMeasured: false に当たったら握り潰さず投げる（0 を返さない）", () => {
    expect(() => requireMeasuredTotal(unmeasured)).toThrow(/requireMeasuredTotal/);
  });

  it("assertAffinityMeasured: 測っているなら通り、affinityMeasured: false なら投げる", () => {
    expect(() => assertAffinityMeasured(measured)).not.toThrow();
    expect(() => assertAffinityMeasured(unmeasured)).toThrow(/assertAffinityMeasured/);
  });
});
