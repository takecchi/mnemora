import { describe, expect, it } from "vitest";
import {
  calibrateRecallFootprint,
  compareWithFullLog,
  estimateRecallFootprint,
  type RecallFootprintProfile,
} from "../recall-footprint.js";
import { DEFAULT_RECALL_LIMIT, DIGEST_BAND_MAX_CHARS } from "../recall.js";

const builtinOrigin = {
  kind: "builtin_default" as const,
  measuredFrom: "test",
  measuredUnder: {
    defaultRecallLimit: 10,
    defaultDigestBandLimit: 50,
    digestBandMaxChars: 4000,
    digestBandMaxEntryChars: 120,
    digestBandEntryFixedOverheadChars: 63,
    digestBandEntrySeparatorChars: 1,
  },
};

function profile(charsPerDigest: number, fixedIndexChars: number): RecallFootprintProfile {
  return { origin: builtinOrigin, charsPerDigest, fixedIndexChars };
}

function calibratedProfile(
  min: number,
  max: number,
  charsPerDigest = 10,
  fixedIndexChars = 100,
): RecallFootprintProfile {
  return {
    origin: {
      kind: "calibrated",
      sampleCount: 2,
      observedMemoryCount: { min, max },
      borrowedFromDefault: [],
    },
    charsPerDigest,
    fixedIndexChars,
  };
}

describe("compareWithFullLog: 判定の境界", () => {
  const fixed100 = profile(10, 100);

  it("見積もり比が 1 からちょうど許容誤差だけ離れていれば too_close_to_call（内側に含む）", () => {
    const above = compareWithFullLog({
      fullLogChars: 200,
      shape: { memoryCountInScope: 0 },
      profile: fixed100,
      tolerance: 0.5,
    });
    expect(above.estimatedShare).toBe(0.5);
    expect(above.verdict).toBe("too_close_to_call");
    const below = compareWithFullLog({
      fullLogChars: 50,
      shape: { memoryCountInScope: 0 },
      profile: fixed100,
      tolerance: 1,
    });
    expect(below.estimatedShare).toBe(2);
    expect(below.verdict).toBe("too_close_to_call");
  });

  it("渡した tolerance の幅で too_close_to_call を判定し、その幅を within_tolerance に名乗る", () => {
    const shape = { memoryCountInScope: 0 };
    const byDefault = compareWithFullLog({ fullLogChars: 120, shape, profile: fixed100 });
    expect(byDefault.verdict).toBe("mnemora_smaller");
    const widened = compareWithFullLog({
      fullLogChars: 120,
      shape,
      profile: fixed100,
      tolerance: 0.2,
    });
    expect(widened.verdict).toBe("too_close_to_call");
    expect(widened.reasons).toContainEqual({
      code: "within_tolerance",
      tolerance: 0.2,
      estimatedShare: widened.estimatedShare,
    });
  });

  it("許容誤差の外で、見積もりが会話ログより小さければ mnemora_smaller、大きければ full_log_smaller", () => {
    const shape = { memoryCountInScope: 0 };
    expect(compareWithFullLog({ fullLogChars: 1000, shape, profile: fixed100 }).verdict).toBe(
      "mnemora_smaller",
    );
    expect(compareWithFullLog({ fullLogChars: 10, shape, profile: fixed100 }).verdict).toBe(
      "full_log_smaller",
    );
  });

  it("tolerance が NaN なら、見積もり比がちょうど 1 でも too_close_to_call にならず、within_tolerance も立たない", () => {
    const shape = { memoryCountInScope: 0 };
    const compare = (fullLogChars: number) =>
      compareWithFullLog({ fullLogChars, shape, profile: fixed100, tolerance: Number.NaN });
    const even = compare(100);
    expect(even.estimatedShare).toBe(1);
    expect(even.verdict).not.toBe("too_close_to_call");
    expect(even.reasons.map((r) => r.code)).not.toContain("within_tolerance");
    expect(compare(1000).verdict).toBe("mnemora_smaller");
    expect(compare(10).verdict).toBe("full_log_smaller");
  });

  it("負の fullLogChars は 0 として扱い、full_log_smaller と full_log_below_fixed_cost を返す", () => {
    const result = compareWithFullLog({
      fullLogChars: -50,
      shape: { memoryCountInScope: 0 },
      profile: fixed100,
    });
    expect(result.estimatedShare).toBe(Number.POSITIVE_INFINITY);
    expect(result.verdict).toBe("full_log_smaller");
    expect(result.reasons).toContainEqual({
      code: "full_log_below_fixed_cost",
      fixedIndexChars: 100,
      fullLogChars: 0,
    });
  });

  it("full_log_below_fixed_cost は fullLogChars が固定分を下回るときだけ立つ（ちょうど固定分なら立たない）", () => {
    const shape = { memoryCountInScope: 0 };
    const codes = (fullLogChars: number) =>
      compareWithFullLog({ fullLogChars, shape, profile: fixed100 }).reasons.map((r) => r.code);
    expect(codes(100)).not.toContain("full_log_below_fixed_cost");
    expect(codes(99)).toContain("full_log_below_fixed_cost");
  });

  it("breakEvenFullLogChars は見積もりの合計 chars である", () => {
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 5 },
      profile: fixed100,
    });
    expect(result.breakEvenFullLogChars).toBe(result.estimate.chars);
    expect(result.estimate.chars).toBe(5 * 10 + 100);
  });
});

describe("compareWithFullLog: reasons の中身", () => {
  it("dominant_term は同点なら memories、digest_band、fixed_index の順で先のものを名指しし、占める割合を添える", () => {
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 5 },
      profile: profile(10, 50),
    });
    expect(result.reasons[0]).toEqual({
      code: "dominant_term",
      term: "memories",
      chars: 50,
      shareOfEstimate: 0.5,
    });
  });

  it("dominant_term が digest_band のとき、chars は目次帯の分だけ（固定分を含まない）", () => {
    const result = compareWithFullLog({
      fullLogChars: 100000,
      shape: { memoryCountInScope: 60 },
      profile: profile(10, 50),
    });
    const first = result.reasons[0];
    expect(first).toMatchObject({ code: "dominant_term", term: "digest_band" });
    expect(first).toHaveProperty("chars", result.estimate.byTier.index - 50);
    expect(first).toHaveProperty(
      "shareOfEstimate",
      (result.estimate.byTier.index - 50) / result.estimate.chars,
    );
  });

  it("目次帯が上限に当たると band_saturated に帯の上限の文字数を添える", () => {
    const result = compareWithFullLog({
      fullLogChars: 100000,
      shape: { memoryCountInScope: 1000 },
      profile: profile(16, 100),
    });
    expect(result.reasons).toContainEqual({
      code: "band_saturated",
      bandChars: DIGEST_BAND_MAX_CHARS,
    });
  });

  it("memories_capped_by_limit は渡した limit（省略なら既定の limit）と件数を名乗り、件数が limit ちょうどなら立たない", () => {
    const find = (shape: { memoryCountInScope: number; limit?: number }) =>
      compareWithFullLog({ fullLogChars: 1000, shape, profile: profile(10, 100) }).reasons.find(
        (r) => r.code === "memories_capped_by_limit",
      );
    expect(find({ memoryCountInScope: 30 })).toEqual({
      code: "memories_capped_by_limit",
      limit: DEFAULT_RECALL_LIMIT,
      memoryCountInScope: 30,
    });
    expect(find({ memoryCountInScope: 30, limit: 5 })).toMatchObject({ limit: 5 });
    expect(find({ memoryCountInScope: DEFAULT_RECALL_LIMIT })).toBeUndefined();
  });

  it("outside_calibrated_range は較正した範囲と、尋ねられた件数（返る件数ではない）を名乗る", () => {
    const result = compareWithFullLog({
      fullLogChars: 100000,
      shape: { memoryCountInScope: 100 },
      profile: calibratedProfile(3, 8),
    });
    expect(result.reasons).toContainEqual({
      code: "outside_calibrated_range",
      observed: { min: 3, max: 8 },
      asked: 100,
    });
  });

  it("使える標本が無い較正は coefficients_borrowed を名乗り、profile_not_calibrated は立てない", () => {
    const calibrated = calibrateRecallFootprint([]);
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 5 },
      profile: calibrated,
    });
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain("coefficients_borrowed");
    expect(codes).not.toContain("profile_not_calibrated");
  });
});

describe("estimateRecallFootprint: 境界", () => {
  it("較正した範囲の端（min・max ちょうど）は外挿でなく、その外側は外挿", () => {
    const p = calibratedProfile(3, 8);
    const extrapolated = (n: number) =>
      estimateRecallFootprint({ memoryCountInScope: n }, p).extrapolated;
    expect(extrapolated(3)).toBe(false);
    expect(extrapolated(8)).toBe(false);
    expect(extrapolated(2)).toBe(true);
    expect(extrapolated(9)).toBe(true);
  });

  it("memoryCountInScope が limit ちょうどなら limit で頭打ちとは言わず、1 件超えれば言う", () => {
    expect(
      estimateRecallFootprint({ memoryCountInScope: 7, limit: 7 }, profile(10, 100))
        .memoriesCappedByLimit,
    ).toBe(false);
    expect(
      estimateRecallFootprint({ memoryCountInScope: 8, limit: 7 }, profile(10, 100))
        .memoriesCappedByLimit,
    ).toBe(true);
  });

  it("目次帯の費用がちょうど上限に達したら bandSaturated（帯 50 件 × 80 字 = 4000 字）", () => {
    const estimate = estimateRecallFootprint({ memoryCountInScope: 60 }, profile(16, 0));
    expect(estimate.bandEntries).toBe(50);
    expect(estimate.bandSaturated).toBe(true);
    const below = estimateRecallFootprint({ memoryCountInScope: 59 }, profile(16, 0));
    expect(below.bandEntries).toBe(49);
    expect(below.bandSaturated).toBe(false);
  });

  it("digest の平均が帯の 1 件の上限を超えても、目次帯の費用は伸びない", () => {
    const at = (cpd: number) =>
      estimateRecallFootprint({ memoryCountInScope: 11 }, profile(cpd, 100)).byTier.index;
    expect(at(500)).toBe(at(120));
    expect(at(121)).toBe(at(120));
    expect(at(119)).toBeLessThan(at(120));
  });
});

describe("calibrateRecallFootprint: 標本の扱いの境界", () => {
  const sample = (memoryCount: number, totalChars: number, extra: object = {}) => ({
    totalChars,
    memoryCount,
    bandEntryCount: 0,
    ...extra,
  });

  it("memoryCount が 0 の標本は使える標本に数えない", () => {
    const calibrated = calibrateRecallFootprint([sample(0, 100), sample(5, 180), sample(8, 228)]);
    expect(calibrated.origin).toMatchObject({
      kind: "calibrated",
      sampleCount: 2,
      observedMemoryCount: { min: 5, max: 8 },
    });
  });

  it("totalInScope が memoryCount より大きい標本は、帯が空でも「帯の資格あり」の固定分 26 字を差し引いて較正する", () => {
    const calibrated = calibrateRecallFootprint([
      sample(3, 16 * 3 + 100 + 26, { totalInScope: 5 }),
      sample(5, 16 * 5 + 100 + 26, { totalInScope: 8 }),
    ]);
    expect(calibrated.charsPerDigest).toBeCloseTo(16, 6);
    expect(calibrated.fixedIndexChars).toBeCloseTo(100, 6);
  });

  it("memoryCount が 1 種類で、借りた切片が標本の総量とちょうど等しい（傾きが 0）なら charsPerDigest も借りる", () => {
    const fallback = profile(7, 100);
    const calibrated = calibrateRecallFootprint([sample(4, 100), sample(4, 100)], fallback);
    expect(calibrated.charsPerDigest).toBe(7);
    expect(calibrated.fixedIndexChars).toBe(100);
    expect(calibrated.origin).toMatchObject({
      borrowedFromDefault: ["fixedIndexChars", "charsPerDigest"],
    });
  });
});
