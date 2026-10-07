import { describe, expect, it } from "vitest";
import {
  SHADOW_HIT1_MIN,
  SHADOW_MRR_THRESHOLD,
  decideRetrievalQualityShadowVerdict,
} from "../retrieval-quality-shadow-verdict.js";

describe("decideRetrievalQualityShadowVerdict(Issue #572 段1)", () => {
  it("MRR・hit@1 のどちらも閾値以上なら pass、reasons は空", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: 0.738095,
      hit1Count: 4,
      probeCount: 7,
    });
    expect(verdict).toEqual({ pass: true, reasons: [] });
  });

  it("MRR だけが閾値を下回れば fail、reasons は MRR の理由だけを積む", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: 0.6,
      hit1Count: 4,
      probeCount: 7,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain("MRR");
  });

  it("hit@1 だけが最低件数を下回れば fail、reasons は hit@1 の理由だけを積む", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: 0.9,
      hit1Count: 2,
      probeCount: 7,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain("hit@1");
  });

  it("両方が閾値を下回れば fail、reasons は両方の理由を積む", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: 0.2,
      hit1Count: 1,
      probeCount: 7,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toHaveLength(2);
  });

  it("MRR がちょうど閾値(境界)なら、その条件は満たしたことになる(>=)", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: SHADOW_MRR_THRESHOLD,
      hit1Count: SHADOW_HIT1_MIN,
      probeCount: 7,
    });
    expect(verdict).toEqual({ pass: true, reasons: [] });
  });

  it("MRR が閾値よりわずかでも下なら fail(境界のすぐ外)", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: SHADOW_MRR_THRESHOLD - 0.0001,
      hit1Count: SHADOW_HIT1_MIN,
      probeCount: 7,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("MRR");
  });

  it("hit@1 がちょうど最低件数(境界)なら、その条件は満たしたことになる(>=)", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: 0.9,
      hit1Count: SHADOW_HIT1_MIN,
      probeCount: 7,
    });
    expect(verdict.pass).toBe(true);
  });

  it("hit@1 が最低件数よりちょうど1件少なければ fail(境界のすぐ外)", () => {
    const verdict = decideRetrievalQualityShadowVerdict({
      mrrOverall: 0.9,
      hit1Count: SHADOW_HIT1_MIN - 1,
      probeCount: 7,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("hit@1");
  });
});
