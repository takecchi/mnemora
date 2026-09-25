import { describe, expect, it } from "vitest";
import {
  computeCapturedMargin,
  computeNoisyMargin,
  noisyMarginsForGroup,
} from "../local-noise-margin.js";
import { noiseEpsilon } from "../synthetic-score-noise.js";
import type { CapturedProbeCandidates, ScoredCandidate } from "../synthetic-score-noise.js";

/**
 * `local-noise-margin.ts`(Issue #109 残件「A」候補案1を local 反実仮想データにも
 * 当てるための margin 計算)の歯。DB もネットワークも要らない。
 */

function candidates(pairs: [string, number][]): ScoredCandidate[] {
  return pairs.map(([externalId, score]) => ({ externalId, score }));
}

describe("computeCapturedMargin", () => {
  it("gold score - distractor score を返す", () => {
    const c = candidates([
      ["gold", 0.8],
      ["distractor", 0.3],
      ["other", 0.1],
    ]);
    expect(computeCapturedMargin(c, "gold", "distractor")).toBeCloseTo(0.5, 10);
  });

  it("gold が居なければ null", () => {
    const c = candidates([["distractor", 0.3]]);
    expect(computeCapturedMargin(c, "gold", "distractor")).toBeNull();
  });

  it("distractor が居なければ null", () => {
    const c = candidates([["gold", 0.8]]);
    expect(computeCapturedMargin(c, "gold", "distractor")).toBeNull();
  });
});

describe("computeNoisyMargin", () => {
  it("sigma=0 のとき computeCapturedMargin と一致する(ノイズ無しの代数的性質)", () => {
    const c = candidates([
      ["gold", 0.8],
      ["distractor", 0.3],
    ]);
    const plain = computeCapturedMargin(c, "gold", "distractor")!;
    const noisy = computeNoisyMargin(c, "gold", "distractor", 0, 7, 3);
    expect(noisy).toBeCloseTo(plain, 12);
  });

  it("sigma>0 のとき、noiseEpsilon から手で計算した値と一致する", () => {
    const c = candidates([
      ["gold", 0.8],
      ["distractor", 0.3],
    ]);
    const sigma = 0.1;
    const seed = 3;
    const streamId = 2;
    const expectedGold = 0.8 * (1 + sigma * noiseEpsilon(seed, streamId, 0));
    const expectedDistractor = 0.3 * (1 + sigma * noiseEpsilon(seed, streamId, 1));
    const expected = expectedGold - expectedDistractor;
    expect(computeNoisyMargin(c, "gold", "distractor", sigma, seed, streamId)).toBeCloseTo(
      expected,
      12,
    );
  });

  it("gold/distractor が見つからなければ null", () => {
    const c = candidates([["other", 0.5]]);
    expect(computeNoisyMargin(c, "gold", "distractor", 0.1, 1, 0)).toBeNull();
  });
});

describe("noisyMarginsForGroup", () => {
  it("probe の並び順のまま margin 配列を返す(streamId は配列の添字)", () => {
    const probes: CapturedProbeCandidates[] = [
      {
        probeId: "p1",
        goldExternalId: "g1",
        distractorExternalId: "d1",
        candidates: candidates([
          ["g1", 0.9],
          ["d1", 0.2],
        ]),
      },
      {
        probeId: "p2",
        goldExternalId: "g2",
        distractorExternalId: "d2",
        candidates: candidates([["other", 0.5]]), // gold/distractor 不在 -> null
      },
    ];
    const margins = noisyMarginsForGroup(probes, 0, 1);
    expect(margins.length).toBe(2);
    expect(margins[0]).toBeCloseTo(0.7, 10);
    expect(margins[1]).toBeNull();
  });
});
