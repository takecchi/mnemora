import { describe, expect, it } from "vitest";
import {
  DEFAULT_MRR_DROP_THRESHOLD,
  SEEDS,
  SEED_COUNT,
  SIGMA_GRID,
  aggregateFalsePositiveBand,
  applySymmetricScoreNoise,
  computeNoisyGroupMetrics,
  decideNoiseRoundRed,
  median,
  noiseEpsilon,
  rankOf,
  summarizeSigmaLevels,
} from "../synthetic-score-noise.js";
import type {
  CapturedProbeCandidates,
  NoiseRoundMetrics,
  ScoredCandidate,
} from "../synthetic-score-noise.js";

describe("SIGMA_GRID / SEEDS(測定前に固定した格子)", () => {
  it("11段・15 seed(Issue #572 に揃えた値)", () => {
    expect(SIGMA_GRID).toHaveLength(11);
    expect(SIGMA_GRID).toEqual([
      0.0025, 0.005, 0.01, 0.02, 0.04, 0.08, 0.12, 0.16, 0.24, 0.32, 0.48,
    ]);
    expect(SEED_COUNT).toBe(15);
    expect(SEEDS).toHaveLength(15);
    expect(SEEDS[0]).toBe(1);
    expect(SEEDS[14]).toBe(15);
  });
});

describe("noiseEpsilon(決定的な擬似乱数)", () => {
  it("同じ引数なら常に同じ値を返す(再現性)", () => {
    const a = noiseEpsilon(3, 1, 7);
    const b = noiseEpsilon(3, 1, 7);
    expect(a).toBe(b);
  });

  it("値域は [-1, 1) に収まる", () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      for (let index = 0; index < 40; index += 1) {
        const v = noiseEpsilon(seed, 0, index);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("seed が違えば(同じ streamId/index でも)値が変わる — 実測で衝突していないことを確認", () => {
    const values = new Set<number>();
    for (let seed = 1; seed <= 15; seed += 1) {
      values.add(noiseEpsilon(seed, 2, 5));
    }
    expect(values.size).toBe(15);
  });

  it("streamId が違えば(同じ seed/index でも)値が変わる — probe をまたいで相関しない", () => {
    const values = new Set<number>();
    for (let streamId = 0; streamId < 10; streamId += 1) {
      values.add(noiseEpsilon(9, streamId, 3));
    }
    expect(values.size).toBe(10);
  });

  it("対称性: 15 seed にわたる平均は 0 付近(⚠ 統計的検定ではない。実測での目安)", () => {
    const values = SEEDS.map((seed) => noiseEpsilon(seed, 4, 11));
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.3);
    // 正負どちらも実際に出ることを確認する(陽性対照——「出た」ことの確認)。
    expect(values.some((v) => v > 0)).toBe(true);
    expect(values.some((v) => v < 0)).toBe(true);
  });
});

function candidate(externalId: string | null, score: number): ScoredCandidate {
  return { externalId, score };
}

describe("applySymmetricScoreNoise", () => {
  const base: ScoredCandidate[] = [
    candidate("gold", 0.9),
    candidate("distractor", 0.8),
    candidate("haystack-1", 0.5),
    candidate("haystack-2", 0.3),
  ];

  it("sigma=0 は並びを一切変えない(元の recall() の順位をそのまま保つ)", () => {
    for (const seed of SEEDS) {
      const reordered = applySymmetricScoreNoise(base, 0, seed, 0);
      expect(reordered.map((c) => c.externalId)).toEqual([
        "gold",
        "distractor",
        "haystack-1",
        "haystack-2",
      ]);
    }
  });

  it("sigma=0 は、スコアの差が極小(1e-6)な接戦でも並びを変えない(僅かでもノイズが漏れる実装を検出する)", () => {
    // gap がわずか 1e-6 —— sigma=0 でも「わずかに」ノイズが混ざる実装(例: sigma の代わりに
    // sigma+定数を使う)があれば、この接戦は必ずどこかの seed でひっくり返る。
    const tight: ScoredCandidate[] = [
      candidate("a", 1),
      candidate("b", 0.999999),
      candidate("c", 0.999998),
      candidate("d", 0.999997),
    ];
    for (const seed of SEEDS) {
      const reordered = applySymmetricScoreNoise(tight, 0, seed, 0);
      expect(reordered.map((c) => c.externalId)).toEqual(["a", "b", "c", "d"]);
    }
  });

  it("元の配列を変更しない(新しい配列を返す)", () => {
    const copy = base.map((c) => ({ ...c }));
    applySymmetricScoreNoise(base, 0.5, 3, 0);
    expect(base).toEqual(copy);
  });

  it("十分大きな sigma では、複数の seed にわたって順位が両方向に動く(陽性対照)", () => {
    const ranksOfGold = SEEDS.map((seed) => {
      const reordered = applySymmetricScoreNoise(base, 0.9, seed, 1);
      return rankOf(reordered, "gold")!;
    });
    expect(ranksOfGold.some((r) => r === 1)).toBe(true);
    expect(ranksOfGold.some((r) => r > 1)).toBe(true);
  });

  it("同点の候補にノイズを掛けたとき、index0 だけが特別扱い(非対称)されない", () => {
    // 4件を完全に同点にし、200 seed にわたって「どの位置(index)の候補が rank1 を
    // 取ったか」を数える。**対称なノイズなら、どの index も概ね同じ頻度で勝つはず**
    // ——「gold(index0 に置かれがちな候補)だけを狙って下げる」非対称な実装は、
    // index0 の勝率を著しく下げる(⚠ 統計的検定ではない。極端な偏りだけを見る)。
    const tiedScore = 1;
    const ids = ["c0", "c1", "c2", "c3"];
    const winsByIndex = [0, 0, 0, 0];
    const trials = 200;
    for (let seed = 1; seed <= trials; seed += 1) {
      const list = ids.map((id) => candidate(id, tiedScore));
      const reordered = applySymmetricScoreNoise(list, 0.5, seed, 0);
      const winnerIndex = ids.indexOf(reordered[0]!.externalId!);
      winsByIndex[winnerIndex] = (winsByIndex[winnerIndex] ?? 0) + 1;
    }
    for (const wins of winsByIndex) {
      expect(wins).toBeGreaterThan(0);
    }
    // 完全に対称なら期待値は trials/4(=50)。10%(=20)を切るのは、著しい偏りが
    // 無ければまず起きない(二項分布 B(200, 0.25) で 20 以下になる確率は極小)。
    expect(winsByIndex[0]).toBeGreaterThan(trials * 0.1);
  });

  it("sigma が大きいほど、無変異の順序からの入れ替わりが増える傾向がある(単調な主張はしない。傾向のみ)", () => {
    const countSwaps = (sigma: number): number => {
      let swaps = 0;
      for (const seed of SEEDS) {
        const reordered = applySymmetricScoreNoise(base, sigma, seed, 2);
        if (
          reordered.map((c) => c.externalId).join(",") !== base.map((c) => c.externalId).join(",")
        ) {
          swaps += 1;
        }
      }
      return swaps;
    };
    expect(countSwaps(0.01)).toBeLessThanOrEqual(countSwaps(0.9));
  });
});

describe("rankOf", () => {
  it("1始まりの順位を返す", () => {
    const list = [candidate("a", 1), candidate("b", 1)];
    expect(rankOf(list, "a")).toBe(1);
    expect(rankOf(list, "b")).toBe(2);
  });

  it("居なければ null", () => {
    const list = [candidate("a", 1)];
    expect(rankOf(list, "z")).toBeNull();
  });
});

describe("computeNoisyGroupMetrics", () => {
  const probes: CapturedProbeCandidates[] = [
    {
      probeId: "p1",
      goldExternalId: "g1",
      distractorExternalId: "d1",
      candidates: [candidate("g1", 0.9), candidate("d1", 0.5), candidate("h1", 0.1)],
    },
    {
      probeId: "p2",
      goldExternalId: "g2",
      distractorExternalId: "d2",
      candidates: [candidate("d2", 0.9), candidate("g2", 0.5), candidate("h2", 0.1)],
    },
  ];

  it("sigma=0: MRR/hit@1 が素朴な順位計算と一致する(基準線の再現)", () => {
    const metrics = computeNoisyGroupMetrics(probes, 0, 1);
    // p1: goldRank=1 → RR=1 / p2: goldRank=2 → RR=0.5
    expect(metrics.mrrOverall).toBeCloseTo((1 + 0.5) / 2, 10);
    expect(metrics.hit1Count).toBe(1);
    expect(metrics.hit10Count).toBe(2);
    expect(metrics.probeCount).toBe(2);
  });

  it("probe が0件なら MRR は0(0除算しない)", () => {
    const metrics = computeNoisyGroupMetrics([], 0.5, 1);
    expect(metrics.mrrOverall).toBe(0);
    expect(metrics.probeCount).toBe(0);
  });
});

describe("median", () => {
  it("奇数個は中央の値", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("偶数個は中央2つの平均", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("空配列は例外", () => {
    expect(() => median([])).toThrow();
  });
});

describe("decideNoiseRoundRed(ADR 0316 の判定への唯一の配線)", () => {
  const baseline: NoiseRoundMetrics = {
    mrrOverall: 0.9166666666666666,
    hit1Count: 15,
    hit10Count: 18,
    probeCount: 18,
  };

  it("測定前に固定した既定の落ち幅(0.01)は変えていない", () => {
    expect(DEFAULT_MRR_DROP_THRESHOLD).toBe(0.01);
  });

  it("基準値と完全一致なら green", () => {
    expect(decideNoiseRoundRed("g", baseline, baseline)).toBe(false);
  });

  it("MRR の落ち幅がちょうど閾値未満(0.0099)なら green(境界のすぐ内側)", () => {
    const measured: NoiseRoundMetrics = { ...baseline, mrrOverall: baseline.mrrOverall - 0.0099 };
    expect(decideNoiseRoundRed("g", measured, baseline)).toBe(false);
  });

  it("MRR の落ち幅がちょうど閾値(0.01)なら red(境界)", () => {
    const measured: NoiseRoundMetrics = { ...baseline, mrrOverall: baseline.mrrOverall - 0.01 };
    expect(decideNoiseRoundRed("g", measured, baseline)).toBe(true);
  });

  it("hit@1 が1件でも基準値を下回れば red(MRR は変えない)", () => {
    const measured: NoiseRoundMetrics = { ...baseline, hit1Count: baseline.hit1Count - 1 };
    expect(decideNoiseRoundRed("g", measured, baseline)).toBe(true);
  });
});

describe("summarizeSigmaLevels / aggregateFalsePositiveBand", () => {
  it("中央値が基準のままの σ だけを帯として合算する", () => {
    const sigmaGrid = [0.01, 0.02, 0.5];
    const redFlagsPerSigma = [
      [false, false, true],
      [false, false, false],
      [true, true, true],
    ];
    const mrrPerSigma = [
      [1, 1, 0.9],
      [1, 1, 1],
      [0.1, 0.2, 0.1],
    ];
    const baselineMrr = 1;
    const levels = summarizeSigmaLevels(sigmaGrid, redFlagsPerSigma, mrrPerSigma, baselineMrr);
    expect(levels[0]!.mrrMedian).toBe(1);
    expect(levels[0]!.medianPreservesBaseline).toBe(true);
    expect(levels[2]!.medianPreservesBaseline).toBe(false);

    const band = aggregateFalsePositiveBand(levels);
    // σ=0.01(中央値1、red1件)と σ=0.02(中央値1、red0件)だけが帯に入る。
    expect(band.bandSigmas).toEqual([0.01, 0.02]);
    expect(band.redCount).toBe(1);
    expect(band.trials).toBe(6);
  });
});
