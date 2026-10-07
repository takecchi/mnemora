import { describe, expect, it } from "vitest";
import { diffGroupCandidates, diffProbeCandidates } from "../local-noise-candidate-diff.js";
import type { CapturedProbeCandidates } from "../synthetic-score-noise.js";

function probe(
  probeId: string,
  candidates: { externalId: string | null; score: number }[],
  overrides: Partial<Pick<CapturedProbeCandidates, "goldExternalId" | "distractorExternalId">> = {},
): CapturedProbeCandidates {
  return {
    probeId,
    goldExternalId: overrides.goldExternalId ?? `gold-${probeId}`,
    distractorExternalId: overrides.distractorExternalId ?? `distractor-${probeId}`,
    candidates,
  };
}

describe("diffProbeCandidates", () => {
  it("候補配列が件数・順序・externalId・score まで完全一致すれば identical=true、denseOnlyIds は空", () => {
    const sparse = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: "distractor-p1", score: 0.5 },
      { externalId: "filler-0000", score: 0.1 },
    ]);
    const dense = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: "distractor-p1", score: 0.5 },
      { externalId: "filler-0000", score: 0.1 },
    ]);

    const diff = diffProbeCandidates(sparse, dense);

    expect(diff.identical).toBe(true);
    expect(diff.matchingPrefixLength).toBe(3);
    expect(diff.denseOnlyIds).toEqual([]);
    expect(diff.sparseOnlyIds).toEqual([]);
    expect(diff.denseOnlyRankedAboveGoldOrDistractor).toBe(false);
    expect(diff.goldRankSparse).toBe(1);
    expect(diff.goldRankDense).toBe(1);
  });

  it("dense 固有の候補が gold/distractor より下位(3位以下)にしか居なければ denseOnlyRankedAboveGoldOrDistractor=false", () => {
    const sparse = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: "distractor-p1", score: 0.5 },
    ]);
    const dense = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: "distractor-p1", score: 0.5 },
      { externalId: "dense-filler-0007", score: 0.2 },
    ]);

    const diff = diffProbeCandidates(sparse, dense);

    expect(diff.identical).toBe(false);
    expect(diff.matchingPrefixLength).toBe(2);
    expect(diff.denseOnlyIds).toEqual(["dense-filler-0007"]);
    expect(diff.denseOnlyRankedAboveGoldOrDistractor).toBe(false);
  });

  it("dense 固有の候補が gold より上位に来ていれば denseOnlyRankedAboveGoldOrDistractor=true(仮説に効く実例)", () => {
    const sparse = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: "distractor-p1", score: 0.5 },
    ]);
    const dense = probe("p1", [
      { externalId: "dense-filler-0007", score: 0.95 },
      { externalId: "gold-p1", score: 0.9 },
      { externalId: "distractor-p1", score: 0.5 },
    ]);

    const diff = diffProbeCandidates(sparse, dense);

    expect(diff.denseOnlyIds).toEqual(["dense-filler-0007"]);
    expect(diff.denseOnlyRankedAboveGoldOrDistractor).toBe(true);
    expect(diff.goldRankDense).toBe(2);
    expect(diff.goldRankSparse).toBe(1);
  });

  it("同じ externalId が同じ index でも score が違えば、その index は entryMatches=false になり matchingPrefixLength はそこで止まる", () => {
    const sparse = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: "distractor-p1", score: 0.5 },
    ]);
    const dense = probe("p1", [
      { externalId: "gold-p1", score: 0.9000001 }, // わずかに違う
      { externalId: "distractor-p1", score: 0.5 },
    ]);

    const diff = diffProbeCandidates(sparse, dense);

    expect(diff.identical).toBe(false);
    expect(diff.matchingPrefixLength).toBe(0);
    expect(diff.perIndex[0]!.idMatches).toBe(true);
    expect(diff.perIndex[0]!.entryMatches).toBe(false);
    expect(diff.perIndex[1]!.entryMatches).toBe(true);
  });

  it("externalId が null の候補(resolveExternalId が解決できなかった)は sparseOnlyIds/denseOnlyIds に数えない", () => {
    const sparse = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: null, score: 0.4 },
    ]);
    const dense = probe("p1", [
      { externalId: "gold-p1", score: 0.9 },
      { externalId: null, score: 0.4 },
    ]);

    const diff = diffProbeCandidates(sparse, dense);

    expect(diff.identical).toBe(true);
    expect(diff.denseOnlyIds).toEqual([]);
    expect(diff.sparseOnlyIds).toEqual([]);
  });

  it("probeId が sparse/dense で食い違っていれば例外にする(対応付けの誤りを黙って通さない)", () => {
    const sparse = probe("p1", [{ externalId: "gold-p1", score: 0.9 }]);
    const dense = probe("p2", [{ externalId: "gold-p2", score: 0.9 }]);

    expect(() => diffProbeCandidates(sparse, dense)).toThrow(/probeId/);
  });

  it("goldExternalId が sparse/dense で食い違っていれば例外にする", () => {
    const sparse = probe("p1", [{ externalId: "gold-p1", score: 0.9 }]);
    const dense = probe("p1", [{ externalId: "gold-p1-different", score: 0.9 }], {
      goldExternalId: "gold-p1-different",
    });

    expect(() => diffProbeCandidates(sparse, dense)).toThrow(/goldExternalId/);
  });

  it("候補が0件のprobeでも例外にならず、goldRank は両方 null になる", () => {
    const sparse = probe("p1", []);
    const dense = probe("p1", []);

    const diff = diffProbeCandidates(sparse, dense);

    expect(diff.identical).toBe(true);
    expect(diff.goldRankSparse).toBeNull();
    expect(diff.goldRankDense).toBeNull();
    expect(diff.denseOnlyRankedAboveGoldOrDistractor).toBe(false);
  });
});

describe("diffGroupCandidates", () => {
  it("probe ごとの diff を集計し、identicalProbeCount と denseOnly の一覧を出す", () => {
    const sparseProbes: CapturedProbeCandidates[] = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.5 },
      ]),
      probe("p2", [
        { externalId: "gold-p2", score: 0.9 },
        { externalId: "distractor-p2", score: 0.5 },
      ]),
    ];
    const denseProbes: CapturedProbeCandidates[] = [
      probe("p1", [
        { externalId: "gold-p1", score: 0.9 },
        { externalId: "distractor-p1", score: 0.5 },
      ]),
      probe("p2", [
        { externalId: "dense-only", score: 0.95 },
        { externalId: "gold-p2", score: 0.9 },
        { externalId: "distractor-p2", score: 0.5 },
      ]),
    ];

    const summary = diffGroupCandidates("identifiers", sparseProbes, denseProbes);

    expect(summary.probeCount).toBe(2);
    expect(summary.identicalProbeCount).toBe(1);
    expect(summary.probesWithDenseOnlyAboveGoldOrDistractor).toEqual(["p2"]);
    expect(summary.diffs.map((d) => d.probeId)).toEqual(["p1", "p2"]);
  });

  it("probe 件数が sparse/dense で違えば例外にする", () => {
    const sparseProbes = [probe("p1", [])];
    const denseProbes = [probe("p1", []), probe("p2", [])];

    expect(() => diffGroupCandidates("identifiers", sparseProbes, denseProbes)).toThrow(
      /probe 件数/,
    );
  });

  it("同じ probeId が dense 側に無ければ例外にする", () => {
    const sparseProbes = [probe("p1", [])];
    const denseProbes = [probe("p-different", [])];

    expect(() => diffGroupCandidates("identifiers", sparseProbes, denseProbes)).toThrow(
      /dense 側に無い/,
    );
  });
});
