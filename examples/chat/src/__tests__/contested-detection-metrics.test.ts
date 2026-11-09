import { describe, expect, it } from "vitest";
import {
  CATEGORY_EXPECTS_CONFLICT,
  CONTESTED_CASES,
  CONTESTED_CATEGORIES,
} from "../contested-detection-case-set.js";
import {
  confusionByCategory,
  confusionOf,
  metricsOf,
  type ContestedCaseResult,
} from "../contested-detection-metrics.js";

describe("contested-detection の指標", () => {
  const results: ContestedCaseResult[] = [
    { id: "a", category: "true_conflict", detected: true },
    { id: "b", category: "explicit_correction", detected: false },
    { id: "c", category: "paraphrase", detected: true },
    { id: "d", category: "non_conflict", detected: false },
  ];

  it("検出されるべきカテゴリの検出は TP・見逃しは FN、されるべきでないカテゴリの検出は FP・非検出は TN", () => {
    expect(confusionOf(results)).toEqual({ tp: 1, fp: 1, fn: 1, tn: 1 });
  });

  it("Precision・Recall・F1 を計算する", () => {
    const m = metricsOf({ tp: 7, fp: 7, fn: 1, tn: 5 });
    expect(m.precision).toBeCloseTo(0.5, 10);
    expect(m.recall).toBeCloseTo(0.875, 10);
    expect(m.f1).toBeCloseTo((2 * 0.5 * 0.875) / 1.375, 10);
  });

  it("分母が0の指標は 0 ではなく null にする（「何も陽性にしなかった」と「全部外した」を区別する）", () => {
    expect(metricsOf({ tp: 0, fp: 0, fn: 3, tn: 2 })).toMatchObject({
      precision: null,
      recall: 0,
      f1: null,
    });
    expect(metricsOf({ tp: 0, fp: 2, fn: 0, tn: 1 })).toMatchObject({ recall: null, f1: null });
  });

  it("カテゴリごとの内訳は、全カテゴリを持ち、合計が全体と一致する", () => {
    const byCategory = confusionByCategory(results);
    expect(Object.keys(byCategory).sort()).toEqual([...CONTESTED_CATEGORIES].sort());
    const sum = Object.values(byCategory).reduce(
      (acc, c) => ({ tp: acc.tp + c.tp, fp: acc.fp + c.fp, fn: acc.fn + c.fn, tn: acc.tn + c.tn }),
      { tp: 0, fp: 0, fn: 0, tn: 0 },
    );
    expect(sum).toEqual(confusionOf(results));
  });
});

describe("contested-detection のケース集合", () => {
  it("どのカテゴリにも4件以上あり、陽性・陰性の両方のカテゴリがある", () => {
    for (const category of CONTESTED_CATEGORIES) {
      expect(CONTESTED_CASES.filter((c) => c.category === category).length).toBeGreaterThanOrEqual(
        4,
      );
    }
    expect(Object.values(CATEGORY_EXPECTS_CONFLICT)).toContain(true);
    expect(Object.values(CATEGORY_EXPECTS_CONFLICT)).toContain(false);
  });

  it("どの発話も、記憶と claim key の数が一致し、id は重複しない", () => {
    for (const c of CONTESTED_CASES) {
      for (const turn of c.turns) {
        expect(turn.keys.length).toBe(turn.memories.length);
      }
    }
    expect(new Set(CONTESTED_CASES.map((c) => c.id)).size).toBe(CONTESTED_CASES.length);
  });
});
