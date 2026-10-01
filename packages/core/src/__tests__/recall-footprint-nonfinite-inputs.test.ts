import { describe, expect, it } from "vitest";
import {
  BUILTIN_RECALL_FOOTPRINT_PROFILE,
  calibrateRecallFootprint,
  compareWithFullLog,
  type RecallFootprintSample,
  type RecallFootprintShape,
} from "../recall-footprint.js";

/**
 * ADR 0467（穴探し38巡目）: `compareWithFullLog` / `calibrateRecallFootprint` に非有限の入力が来たとき、
 * 結論や「較正済み」の顔で NaN・Infinity を返さない。
 */

const sample = (memoryCount: number, totalChars: number): RecallFootprintSample => ({
  memoryCount,
  totalChars,
  bandEntryCount: 0,
});

const finite = (n: number) => Number.isFinite(n);

describe("compareWithFullLog: 見積もりが数にならない入力では結論を出さない（ADR 0467）", () => {
  const nanShapes: Array<[string, RecallFootprintShape]> = [
    ["memoryCountInScope", { memoryCountInScope: Number.NaN }],
    ["limit", { memoryCountInScope: 50, limit: Number.NaN }],
    ["digestBandLimit", { memoryCountInScope: 50, digestBandLimit: Number.NaN }],
    ["associationCount", { memoryCountInScope: 50, associationCount: Number.NaN }],
  ];

  it.each(nanShapes)(
    "shape.%s が NaN なら too_close_to_call（mnemora_smaller / full_log_smaller と言わない）",
    (_n, shape) => {
      const r = compareWithFullLog({ fullLogChars: 100_000, shape });
      expect(r.verdict).toBe("too_close_to_call");
      expect(Number.isNaN(r.estimatedShare)).toBe(true);
      // 「許容誤差の内側」とは言っていない（within_tolerance は NaN の estimatedShare を載せてしまう）。
      expect(r.reasons.map((x) => x.code)).not.toContain("within_tolerance");
      // reasons は空にならない（既存の約束）。
      expect(r.reasons.length).toBeGreaterThan(0);
    },
  );

  it("fullLogChars が NaN なら too_close_to_call（Infinity の share で full_log_smaller と言わない）", () => {
    const r = compareWithFullLog({ fullLogChars: Number.NaN, shape: { memoryCountInScope: 50 } });
    expect(r.verdict).toBe("too_close_to_call");
    expect(Number.isNaN(r.estimatedShare)).toBe(true);
    expect(r.reasons.map((x) => x.code)).not.toContain("within_tolerance");
  });

  it("陽性対照: 有限な入力の結論は変わらない", () => {
    const small = compareWithFullLog({ fullLogChars: 100_000, shape: { memoryCountInScope: 50 } });
    expect(small.verdict).toBe("mnemora_smaller");
    const big = compareWithFullLog({ fullLogChars: 10, shape: { memoryCountInScope: 50 } });
    expect(big.verdict).toBe("full_log_smaller");
    const empty = compareWithFullLog({ fullLogChars: 0, shape: { memoryCountInScope: 50 } });
    expect(empty.verdict).toBe("full_log_smaller");
    expect(empty.estimatedShare).toBe(Number.POSITIVE_INFINITY);
    // 非有限の limit の外でも、Infinity の memoryCountInScope は min で有限に収まり、結論を出す（今までどおり）。
    const inf = compareWithFullLog({
      fullLogChars: 100_000,
      shape: { memoryCountInScope: Number.POSITIVE_INFINITY },
    });
    expect(inf.verdict).toBe("mnemora_smaller");
  });
});

describe("calibrateRecallFootprint: 非有限の標本・オーバーフローで、NaN・Infinity の係数を『較正済み』の顔で返さない（ADR 0467）", () => {
  const cases: Array<[string, RecallFootprintSample[]]> = [
    ["totalChars が NaN（件数2種）", [sample(2, Number.NaN), sample(5, 2000)]],
    ["totalChars が Infinity（件数2種）", [sample(2, Number.POSITIVE_INFINITY), sample(5, 2000)]],
    ["totalChars が Infinity（件数1種）", [sample(3, Number.POSITIVE_INFINITY)]],
    ["memoryCount が Infinity", [sample(Number.POSITIVE_INFINITY, 100), sample(5, 2000)]],
    ["有限だが合計がオーバーフローする", [sample(2, 1.7e308), sample(5, 1.7e308)]],
  ];

  it.each(cases)("%s: 係数は有限で、出所の件数も有限", (_n, samples) => {
    const p = calibrateRecallFootprint(samples);
    expect(finite(p.charsPerDigest)).toBe(true);
    expect(finite(p.fixedIndexChars)).toBe(true);
    expect(p.charsPerDigest).toBeGreaterThan(0);
    if (p.origin.kind === "calibrated") {
      expect(finite(p.origin.observedMemoryCount.min)).toBe(true);
      expect(finite(p.origin.observedMemoryCount.max)).toBe(true);
    }
  });

  it("切片が決められなければ、傾きと同じ形で既定値から借りて名前で出す", () => {
    const p = calibrateRecallFootprint([sample(2, 1.7e308), sample(5, 1.7e308)]);
    expect(p.origin.kind === "calibrated" && p.origin.borrowedFromDefault).toContain(
      "fixedIndexChars",
    );
    expect(p.fixedIndexChars).toBe(BUILTIN_RECALL_FOOTPRINT_PROFILE.fixedIndexChars);
  });

  it("傾きが Infinity になる件数1種の標本は、傾きを借りて名前で出す", () => {
    const p = calibrateRecallFootprint([sample(3, Number.MAX_VALUE), sample(3, Number.MAX_VALUE)]);
    expect(finite(p.charsPerDigest)).toBe(true);
    expect(p.origin.kind === "calibrated" && p.origin.borrowedFromDefault).toContain(
      "charsPerDigest",
    );
  });

  it("非有限の標本は使える標本に数えない（sampleCount は使った分）", () => {
    const p = calibrateRecallFootprint([sample(2, Number.NaN), sample(5, 2000), sample(7, 2600)]);
    expect(p.origin.kind === "calibrated" && p.origin.sampleCount).toBe(2);
  });

  it("陽性対照: 有限な標本の較正は変わらない", () => {
    const p = calibrateRecallFootprint([sample(2, 1000), sample(5, 2000)]);
    expect(p.charsPerDigest).toBeCloseTo(1000 / 3, 6);
    expect(p.fixedIndexChars).toBeCloseTo(1000 / 3, 6);
    expect(p.origin.kind === "calibrated" && p.origin.borrowedFromDefault).toEqual([]);
  });

  it("標本が20万件でも RangeError にならない（スプレッド引数の上限）", () => {
    const samples = Array.from({ length: 200_000 }, (_, i) =>
      sample(1 + (i % 7), 300 + 100 * (i % 7)),
    );
    const p = calibrateRecallFootprint(samples);
    expect(p.origin.kind === "calibrated" && p.origin.sampleCount).toBe(200_000);
    expect(p.origin.kind === "calibrated" && p.origin.observedMemoryCount).toEqual({
      min: 1,
      max: 7,
    });
    expect(p.charsPerDigest).toBeCloseTo(100, 6);
    expect(p.fixedIndexChars).toBeCloseTo(200, 6);
  });
});

describe("calibrateRecallFootprint: 傾きだけがオーバーフローで Infinity になる（ADR 0467）", () => {
  it("Infinity の傾きを採らず、既定値から借りて名前で出す", () => {
    const p = calibrateRecallFootprint([sample(1, 0), sample(3, 4e307)]);
    expect(finite(p.charsPerDigest)).toBe(true);
    expect(p.origin.kind === "calibrated" && p.origin.borrowedFromDefault).toContain(
      "charsPerDigest",
    );
  });
});
