import { describe, expect, it } from "vitest";
import { compareGroupNoiseOutcomes } from "../local-noise-grid-comparison.js";
import type { CapturedProbeCandidates } from "../synthetic-score-noise.js";

/**
 * Issue #109（06:58Z のコメント4番）が残した仮説——「ADR 0322 の sparse/dense 群の
 * 結果が σ・seed の全組で完全に一致した」——を数値として突き合わせる
 * `compareGroupNoiseOutcomes` に対する、DB 非依存の純関数の歯。実際の `local` 埋め込みでの
 * 全組突き合わせは `src/scripts/local-noise-arm-candidate-diff.ts` を手で実行して行う。
 */

function probe(
  probeId: string,
  candidates: { externalId: string | null; score: number }[],
): CapturedProbeCandidates {
  return {
    probeId,
    goldExternalId: `gold-${probeId}`,
    distractorExternalId: `distractor-${probeId}`,
    candidates,
  };
}

const SIGMA_GRID = [0.0025, 0.01, 0.1];
const SEEDS = [1, 2, 3, 4, 5];

describe("compareGroupNoiseOutcomes", () => {
  it("sparse/dense が完全に同じ候補集合なら、全 round で MRR・red が一致する", () => {
    const sparseProbes = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.5 },
        { externalId: "filler-0", score: 0.2 },
      ]),
    ];
    const denseProbes = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.5 },
        { externalId: "filler-0", score: 0.2 },
      ]),
    ];

    const summary = compareGroupNoiseOutcomes("g", sparseProbes, denseProbes, SIGMA_GRID, SEEDS);

    expect(summary.totalRounds).toBe(SIGMA_GRID.length * SEEDS.length);
    expect(summary.mrrExactMatchCount).toBe(summary.totalRounds);
    expect(summary.redMatchCount).toBe(summary.totalRounds);
    expect(summary.mismatches).toEqual([]);
  });

  it("dense 固有の候補が gold/distractor より常に下位なら、低い σ では一致し続ける", () => {
    const sparseProbes = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.5 },
      ]),
    ];
    const denseProbes = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.5 },
        // dense 固有・常に最下位のスコア。低い σ ではこの候補が gold/distractor を
        // 追い越すことはない。
        { externalId: "dense-only", score: 0.05 },
      ]),
    ];

    const summary = compareGroupNoiseOutcomes(
      "g",
      sparseProbes,
      denseProbes,
      [0.0025, 0.005],
      SEEDS,
    );

    expect(summary.mismatches).toEqual([]);
  });

  it("dense 固有の候補が gold を追い越しうる場合、高い σ では MRR/red が食い違いうる(mismatch を検出する)", () => {
    const sparseProbes = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.1 },
      ]),
    ];
    const denseProbes = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.1 },
        // gold に極めて近いスコア。大きな σ ならノイズだけで逆転しうる。
        { externalId: "dense-only", score: 0.89 },
      ]),
    ];

    // σ=0.9 のような極端な値なら、位置0(gold)と位置2(dense-only)の間でノイズにより
    // 逆転が起きるはず。sparse 側にはそもそも位置2の候補が無いので、この逆転は
    // dense 側だけで起き、mismatch が最低1件は出る。
    const summary = compareGroupNoiseOutcomes("g", sparseProbes, denseProbes, [0.9], SEEDS);

    expect(summary.mismatches.length).toBeGreaterThan(0);
    expect(summary.mrrExactMatchCount + summary.mismatches.length).toBeGreaterThanOrEqual(
      summary.totalRounds,
    );
  });

  it("baselineSeed を変えても sigma=0 の基準値は変わらないので、結果に影響しない", () => {
    const sparseProbes = [probe("p1", [{ externalId: "gold-p1", score: 0.9 }])];
    const denseProbes = [probe("p1", [{ externalId: "gold-p1", score: 0.9 }])];

    const a = compareGroupNoiseOutcomes("g", sparseProbes, denseProbes, [0.1], [1], 1);
    const b = compareGroupNoiseOutcomes("g", sparseProbes, denseProbes, [0.1], [1], 7);

    expect(a).toEqual(b);
  });
});
