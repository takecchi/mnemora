import { describe, expect, it } from "vitest";
import {
  aggregateByPair,
  assertWithinHardCallLimit,
  chooseTrialCount,
  exactSignTestPValue,
  formatPairKey,
  isCorrect,
  overallRate,
  summarizeSignTest,
  type PairedTrialOutcome,
} from "../association-answer-correctness-measure-lib.js";

describe("formatPairKey", () => {
  it("caseId と policy を / で結ぶ", () => {
    expect(formatPairKey({ caseId: "dev-a2-remote-work-day", policy: "legacy" })).toBe(
      "dev-a2-remote-work-day/legacy",
    );
  });
});

describe("chooseTrialCount", () => {
  it("6組・予算190・上限5 なら 5 になる(190/(2*6)=15.8→15、5でcap)", () => {
    expect(chooseTrialCount(6, 190, 5)).toBe(5);
  });

  it("14組・予算190・上限5 なら 5 になる(190/(2*14)=6.79→6、5でcap)", () => {
    expect(chooseTrialCount(14, 190, 5)).toBe(5);
  });

  it("40組・予算190・上限5 なら 2 になる(190/(2*40)=2.375→2)", () => {
    expect(chooseTrialCount(40, 190, 5)).toBe(2);
  });

  it("組が0件なら0を返す", () => {
    expect(chooseTrialCount(0, 190, 5)).toBe(0);
  });

  it("予算が足りなければ0を返す(切り捨てが0になる場合)", () => {
    expect(chooseTrialCount(100, 190, 5)).toBe(0);
  });
});

describe("assertWithinHardCallLimit", () => {
  it("上限未満なら例外を投げない", () => {
    expect(() => assertWithinHardCallLimit(198, 200, "test")).not.toThrow();
  });

  it("199回済み(次で200回目、ちょうど上限)は例外を投げない", () => {
    expect(() => assertWithinHardCallLimit(199, 200, "test")).not.toThrow();
  });

  it("200回済み(次で201回目、上限超え)は例外を投げる", () => {
    expect(() => assertWithinHardCallLimit(200, 200, "test")).toThrow(/ハードリミット/);
  });
});

describe("isCorrect", () => {
  it("pass だけが true", () => {
    expect(isCorrect("pass")).toBe(true);
    expect(isCorrect("fail")).toBe(false);
    expect(isCorrect("indeterminate")).toBe(false);
  });
});

describe("aggregateByPair", () => {
  it("組ごとの off/on 正答数を数える", () => {
    const outcomes: PairedTrialOutcome[] = [
      {
        pair: { caseId: "a", policy: "legacy" },
        trial: 1,
        offVerdict: "fail",
        onVerdict: "pass",
      },
      {
        pair: { caseId: "a", policy: "legacy" },
        trial: 2,
        offVerdict: "pass",
        onVerdict: "pass",
      },
      {
        pair: { caseId: "b", policy: "eventAwareFreshness" },
        trial: 1,
        offVerdict: "pass",
        onVerdict: "fail",
      },
    ];
    const aggregated = aggregateByPair(outcomes);
    const a = aggregated.find((x) => x.pair.caseId === "a");
    const b = aggregated.find((x) => x.pair.caseId === "b");
    expect(a).toEqual({
      pair: { caseId: "a", policy: "legacy" },
      n: 2,
      offPassCount: 1,
      onPassCount: 2,
    });
    expect(b).toEqual({
      pair: { caseId: "b", policy: "eventAwareFreshness" },
      n: 1,
      offPassCount: 1,
      onPassCount: 0,
    });
  });
});

describe("exactSignTestPValue", () => {
  it("不一致が無ければ p=1", () => {
    expect(exactSignTestPValue(0, 0)).toBe(1);
  });

  it("完全に対称(b=c)なら p=1", () => {
    expect(exactSignTestPValue(3, 3)).toBe(1);
  });

  it("n=1、片方だけ勝ちは p=1(2*0.5=1)", () => {
    expect(exactSignTestPValue(1, 0)).toBeCloseTo(1, 10);
  });

  it("n=10ですべてon勝ちなら有意に小さいp値になる(2*(1/1024)≈0.00195)", () => {
    expect(exactSignTestPValue(10, 0)).toBeCloseTo((2 * 1) / 1024, 6);
  });

  it("p値は常に0以上1以下", () => {
    for (let b = 0; b <= 8; b += 1) {
      for (let c = 0; c <= 8; c += 1) {
        const p = exactSignTestPValue(b, c);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("summarizeSignTest", () => {
  it("一致/不一致を正しく分類し、pValueを計算する", () => {
    const outcomes: PairedTrialOutcome[] = [
      { pair: { caseId: "a", policy: "legacy" }, trial: 1, offVerdict: "fail", onVerdict: "pass" },
      { pair: { caseId: "a", policy: "legacy" }, trial: 2, offVerdict: "fail", onVerdict: "pass" },
      {
        pair: { caseId: "b", policy: "legacy" },
        trial: 1,
        offVerdict: "pass",
        onVerdict: "fail",
      },
      { pair: { caseId: "c", policy: "legacy" }, trial: 1, offVerdict: "pass", onVerdict: "pass" },
      {
        pair: { caseId: "d", policy: "legacy" },
        trial: 1,
        offVerdict: "fail",
        onVerdict: "indeterminate",
      },
    ];
    const summary = summarizeSignTest(outcomes);
    expect(summary.onWinsOffLoses).toBe(2);
    expect(summary.offWinsOnLoses).toBe(1);
    expect(summary.concordant).toBe(2);
    expect(summary.discordantTotal).toBe(3);
    expect(summary.pValue).toBe(exactSignTestPValue(2, 1));
  });
});

describe("overallRate", () => {
  it("pass の割合を数える", () => {
    const rate = overallRate(["pass", "pass", "fail", "indeterminate"]);
    expect(rate).toEqual({ passCount: 2, total: 4, rate: 0.5 });
  });

  it("空配列なら rate=0", () => {
    expect(overallRate([])).toEqual({ passCount: 0, total: 0, rate: 0 });
  });
});
