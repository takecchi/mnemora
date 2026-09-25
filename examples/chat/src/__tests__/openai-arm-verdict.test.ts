import { describe, expect, it } from "vitest";
import {
  clopperPearsonUpperBound,
  decideEmbeddingDriftVerdict,
  regularizedIncompleteBeta,
} from "../openai-arm-verdict.js";

describe("regularizedIncompleteBeta", () => {
  it("a=1 のとき、閉じた式 I_x(1,b) = 1-(1-x)^b と一致する(検算)", () => {
    for (const [x, b] of [
      [0.05, 59],
      [0.3, 12],
      [0.9, 3],
    ] as const) {
      const closed = 1 - (1 - x) ** b;
      expect(regularizedIncompleteBeta(x, 1, b)).toBeCloseTo(closed, 10);
    }
  });

  it("境界 x=0 は0、x=1は1", () => {
    expect(regularizedIncompleteBeta(0, 2, 5)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 5)).toBe(1);
  });

  it("対称性 I_x(a,b) = 1 - I_{1-x}(b,a)", () => {
    expect(regularizedIncompleteBeta(0.3, 4, 7)).toBeCloseTo(
      1 - regularizedIncompleteBeta(0.7, 7, 4),
      10,
    );
  });

  it("x について単調増加である", () => {
    const xs = [0.01, 0.1, 0.3, 0.5, 0.7, 0.85];
    const values = xs.map((x) => regularizedIncompleteBeta(x, 3, 20));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });
});

describe("clopperPearsonUpperBound", () => {
  it("successes=0, trials=59 で、閉じた式 1-alpha^(1/59) と一致する(マネージャー指示のK=59の根拠)", () => {
    const ub = clopperPearsonUpperBound(0, 59, 0.05);
    const closed = 1 - 0.05 ** (1 / 59);
    expect(ub).toBeCloseTo(closed, 8);
    // 「赤が0件のとき上限が5%前後になる」の実測確認。
    expect(ub).toBeGreaterThan(0.04);
    expect(ub).toBeLessThan(0.055);
  });

  it("successes=0, trials=300 では上限がさらに下がる(単調性)", () => {
    const ub59 = clopperPearsonUpperBound(0, 59, 0.05);
    const ub300 = clopperPearsonUpperBound(0, 300, 0.05);
    expect(ub300).toBeLessThan(ub59);
  });

  it("successes=trials では上限は1", () => {
    expect(clopperPearsonUpperBound(5, 5, 0.05)).toBe(1);
  });

  it("successes が増えるほど上限は単調に上がる", () => {
    const bounds = [0, 1, 2, 3, 5].map((s) => clopperPearsonUpperBound(s, 59, 0.05));
    for (let i = 1; i < bounds.length; i += 1) {
      expect(bounds[i]!).toBeGreaterThan(bounds[i - 1]!);
    }
  });

  it("不正な入力は例外", () => {
    expect(() => clopperPearsonUpperBound(-1, 10)).toThrow();
    expect(() => clopperPearsonUpperBound(11, 10)).toThrow();
    expect(() => clopperPearsonUpperBound(1.5, 10)).toThrow();
  });
});

describe("decideEmbeddingDriftVerdict", () => {
  const baseline = [
    { group: "identifiersSparse", mrrOverall: 1, hit1Count: 30, hit10Count: 30, probeCount: 30 },
    { group: "numeralSparse", mrrOverall: 0.9166666666666666, hit1Count: 15, hit10Count: 18, probeCount: 18 },
  ];

  it("基準値と完全一致なら green", () => {
    const verdict = decideEmbeddingDriftVerdict(baseline, baseline);
    expect(verdict.red).toBe(false);
    expect(verdict.groups.every((g) => !g.red)).toBe(true);
  });

  it("hit@1 が基準値より1件でも下回れば red(ceiling 群の主眼)", () => {
    const measured = [
      { ...baseline[0]!, hit1Count: 29, mrrOverall: 0.9933333333333333 },
      baseline[1]!,
    ];
    const verdict = decideEmbeddingDriftVerdict(measured, baseline);
    expect(verdict.red).toBe(true);
    expect(verdict.groups[0]!.red).toBe(true);
    expect(verdict.groups[1]!.red).toBe(false);
  });

  it("MRR が閾値未満の落ち幅なら green(hit@1 は変わらない前提)", () => {
    const measured = [baseline[0]!, { ...baseline[1]!, mrrOverall: 0.9166666666666666 - 0.005 }];
    const verdict = decideEmbeddingDriftVerdict(measured, baseline, { mrrDropThreshold: 0.01 });
    expect(verdict.red).toBe(false);
  });

  it("MRR が閾値以上落ちれば red", () => {
    const measured = [baseline[0]!, { ...baseline[1]!, mrrOverall: 0.9166666666666666 - 0.02 }];
    const verdict = decideEmbeddingDriftVerdict(measured, baseline, { mrrDropThreshold: 0.01 });
    expect(verdict.red).toBe(true);
    expect(verdict.groups[1]!.red).toBe(true);
  });

  it("基準値に無い群は red にしない", () => {
    const measured = [{ group: "unknownGroup", mrrOverall: 0, hit1Count: 0, hit10Count: 0, probeCount: 0 }];
    const verdict = decideEmbeddingDriftVerdict(measured, baseline);
    expect(verdict.red).toBe(false);
  });
});
