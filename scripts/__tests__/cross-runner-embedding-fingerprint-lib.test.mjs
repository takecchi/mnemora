import { describe, expect, it } from "vitest";
import {
  CROSS_RUNNER_BASELINE_LEG_ID,
  CROSS_RUNNER_NUM_THREADS,
  CROSS_RUNNER_REPS,
  CROSS_RUNNER_RUNNERS,
  allExpectedCrossRunnerLegs,
  buildBaselineComparisons,
  buildCrossRunnerSummaryMarkdown,
  buildGroupSummaries,
  buildPairwiseComparisons,
  classifyLegPair,
  compareVectorSets,
  crossRunnerArtifactName,
  crossRunnerLegId,
  firstDivergentSignificantDigit,
  float32BitsHex,
  parseCrossRunnerArtifactName,
  sha256HexOfFloat32Vectors,
  ulpDistanceFloat32,
  vectorsToFloat32Hex,
} from "../cross-runner-embedding-fingerprint-lib.mjs";

describe("crossRunnerLegId / crossRunnerArtifactName / parseCrossRunnerArtifactName — 脚の識別の往復", () => {
  it("id は runner label・numThreads・rep から一意に決まる", () => {
    expect(crossRunnerLegId("ubuntu-24.04-arm", 2, 1)).toBe("runner-ubuntu-24.04-arm--nt-2--rep-1");
  });

  it("artifact 名から runner label・numThreads・rep を復元できる（往復）", () => {
    for (const runner of CROSS_RUNNER_RUNNERS) {
      for (const numThreads of CROSS_RUNNER_NUM_THREADS) {
        for (const rep of CROSS_RUNNER_REPS) {
          const name = crossRunnerArtifactName(runner.label, numThreads, rep);
          expect(parseCrossRunnerArtifactName(name)).toEqual({
            runnerLabel: runner.label,
            numThreads,
            rep,
          });
        }
      }
    }
  });

  it("形が合わない名前は null（例外を投げない）", () => {
    expect(parseCrossRunnerArtifactName("not-a-cross-runner-artifact")).toBeNull();
    expect(
      parseCrossRunnerArtifactName("cross-runner-embedding-fingerprint--runner-x--nt-a--rep-1"),
    ).toBeNull();
  });

  it("allExpectedCrossRunnerLegs は runner数 × numThreads数 × rep数 件を返す", () => {
    const legs = allExpectedCrossRunnerLegs();
    expect(legs.length).toBe(
      CROSS_RUNNER_RUNNERS.length * CROSS_RUNNER_NUM_THREADS.length * CROSS_RUNNER_REPS.length,
    );
    // 陽性対照: 基準脚がちょうど1件、実際に含まれている。
    expect(legs.filter((leg) => leg.id === CROSS_RUNNER_BASELINE_LEG_ID)).toHaveLength(1);
  });
});

describe("float32BitsHex — IEEE754 単精度のビットパターン", () => {
  it("1.0 は 0x3f800000", () => {
    expect(float32BitsHex(1.0)).toBe("3f800000");
  });

  it("-1.0 は符号ビットが立つ 0xbf800000", () => {
    expect(float32BitsHex(-1.0)).toBe("bf800000");
  });

  it("0 は 0x00000000", () => {
    expect(float32BitsHex(0)).toBe("00000000");
  });
});

describe("ulpDistanceFloat32 — 隣接 float32 との距離", () => {
  it("同じ値なら距離0", () => {
    expect(ulpDistanceFloat32(1.5, 1.5)).toBe(0);
  });

  it("+0 と -0 の距離は0（符号だけの違いを1 ULPと数えない）", () => {
    expect(ulpDistanceFloat32(0, -0)).toBe(0);
  });

  it("float32 として1つ隣（1.0 の次の表現可能な値）は距離1", () => {
    // float32 の 1.0 における ULP は 2^-23。
    const nextUp = Math.fround(1.0 + 2 ** -23);
    expect(nextUp).not.toBe(1.0);
    expect(ulpDistanceFloat32(1.0, nextUp)).toBe(1);
  });

  it("0 に極めて近い正負の最小刻み同士は距離2（0 を挟んで1ずつ）", () => {
    const smallestPositive = Math.fround(2 ** -149); // float32 最小の正の非正規化数
    expect(ulpDistanceFloat32(smallestPositive, -smallestPositive)).toBe(2);
  });

  it("NaN が絡むと null（距離という概念が無い）", () => {
    expect(ulpDistanceFloat32(NaN, 1)).toBeNull();
    expect(ulpDistanceFloat32(1, Infinity)).toBeNull();
  });
});

describe("firstDivergentSignificantDigit — 何桁目の有効数字からずれるか", () => {
  it("完全に一致していれば null", () => {
    expect(firstDivergentSignificantDigit(1.5, 1.5)).toBeNull();
  });

  it("1桁目（先頭）からずれる: 符号が違う", () => {
    expect(firstDivergentSignificantDigit(1.5, -1.5)).toBe(1);
  });

  it("1桁目からずれる: 桁数(指数)が違う", () => {
    expect(firstDivergentSignificantDigit(1.0, 10.0)).toBe(1);
  });

  it("5桁目からずれる例", () => {
    // 1.2345... と 1.2346... —— 先頭4桁 "1234" は一致、5桁目 "5" vs "6" で食い違う。
    expect(firstDivergentSignificantDigit(1.2345, 1.2346)).toBe(5);
  });

  it("片方だけ0なら1桁目からずれる（0 と 0 は上の『完全一致』で弾かれる）", () => {
    expect(firstDivergentSignificantDigit(0, 1e-10)).toBe(1);
  });
});

describe("compareVectorSets — ベクトル集合同士の突き合わせ", () => {
  it("本数が違えば comparable: false", () => {
    const result = compareVectorSets([[1, 2]], []);
    expect(result.comparable).toBe(false);
  });

  it("次元数が違えば comparable: false", () => {
    const result = compareVectorSets([[1, 2]], [[1, 2, 3]]);
    expect(result.comparable).toBe(false);
  });

  it("完全一致なら maxAbsDiff/maxUlpDiff/mismatchComponentCount がすべて0、cosine類似度は1", () => {
    const v = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    const result = compareVectorSets(
      v,
      v.map((row) => [...row]),
    );
    expect(result.comparable).toBe(true);
    if (!result.comparable) throw new Error("unreachable");
    expect(result.maxAbsDiff).toBe(0);
    expect(result.maxUlpDiff).toBe(0);
    expect(result.mismatchComponentCount).toBe(0);
    expect(result.firstDivergentSignificantDigit).toBeNull();
    expect(result.cosineSimilarity).toBeCloseTo(1, 10);
  });

  it("1成分だけ float32 で1 ULP ずれている場合を検出する", () => {
    const base = [[1.0, 2.0, 3.0]];
    const nextUp = Math.fround(1.0 + 2 ** -23);
    const shifted = [[nextUp, 2.0, 3.0]];
    const result = compareVectorSets(base, shifted);
    expect(result.comparable).toBe(true);
    if (!result.comparable) throw new Error("unreachable");
    expect(result.mismatchComponentCount).toBe(1);
    expect(result.maxUlpDiff).toBe(1);
    expect(result.maxAbsDiff).toBeGreaterThan(0);
  });
});

describe("sha256HexOfFloat32Vectors / vectorsToFloat32Hex", () => {
  it("同じベクトルなら同じ sha256、異なれば異なる sha256", () => {
    const a = sha256HexOfFloat32Vectors([[1, 2, 3]]);
    const b = sha256HexOfFloat32Vectors([[1, 2, 3]]);
    const c = sha256HexOfFloat32Vectors([[1, 2, 3.001]]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("vectorsToFloat32Hex は成分数と同じ形の hex 配列を返す", () => {
    const hex = vectorsToFloat32Hex([[1, -1, 0]]);
    expect(hex).toEqual([["3f800000", "bf800000", "00000000"]]);
  });
});

/** テスト用の leg を作る小道具。 */
function makeLeg(overrides) {
  return {
    id: "leg",
    runnerLabel: "ubuntu-latest",
    arch: "x64",
    numThreads: 4,
    rep: 1,
    present: true,
    ...overrides,
  };
}

const OK_RECORD_A = {
  status: "ok",
  vectors: [[1, 2, 3]],
  sha256Float32: sha256HexOfFloat32Vectors([[1, 2, 3]]),
};
const OK_RECORD_B_MATCH = {
  status: "ok",
  vectors: [[1, 2, 3]],
  sha256Float32: sha256HexOfFloat32Vectors([[1, 2, 3]]),
};
const OK_RECORD_B_MISMATCH = {
  status: "ok",
  vectors: [[1, 2, 3.5]],
  sha256Float32: sha256HexOfFloat32Vectors([[1, 2, 3.5]]),
};

describe("classifyLegPair — 「比較できなかった」を「一致」にしない", () => {
  it("片方の artifact が無ければ incomparable", () => {
    const a = makeLeg({ id: "a", record: OK_RECORD_A });
    const b = makeLeg({ id: "b", present: false });
    expect(classifyLegPair(a, b).status).toBe("incomparable");
  });

  it("片方が読めなかった(error)なら incomparable", () => {
    const a = makeLeg({ id: "a", record: OK_RECORD_A });
    const b = makeLeg({ id: "b", error: "JSON parse に失敗した" });
    expect(classifyLegPair(a, b).status).toBe("incomparable");
  });

  it("片方が weights_unavailable なら incomparable", () => {
    const a = makeLeg({ id: "a", record: OK_RECORD_A });
    const b = makeLeg({ id: "b", record: { status: "weights_unavailable" } });
    expect(classifyLegPair(a, b).status).toBe("incomparable");
  });

  it("両方揃っていて sha256Float32 が同じなら match", () => {
    const a = makeLeg({ id: "a", record: OK_RECORD_A });
    const b = makeLeg({ id: "b", record: OK_RECORD_B_MATCH });
    const result = classifyLegPair(a, b);
    expect(result.status).toBe("match");
  });

  it("両方揃っていて sha256Float32 が違えば mismatch（かつ統計を持つ）", () => {
    const a = makeLeg({ id: "a", record: OK_RECORD_A });
    const b = makeLeg({ id: "b", record: OK_RECORD_B_MISMATCH });
    const result = classifyLegPair(a, b);
    expect(result.status).toBe("mismatch");
    if (result.status !== "mismatch") throw new Error("unreachable");
    expect(result.mismatchComponentCount).toBe(1);
    expect(result.maxAbsDiff).toBeCloseTo(0.5, 5);
  });

  // ⭐ 陽性対照: この歯自体が「常に match と言うだけの空歯」になっていないことを示す。
  it("陽性対照: 明らかに異なる入力に対して実際に mismatch/incomparable のどちらかを返す（match 固定ではない）", () => {
    const alwaysMatch = [
      classifyLegPair(
        makeLeg({ id: "a", record: OK_RECORD_A }),
        makeLeg({ id: "b", present: false }),
      ).status,
      classifyLegPair(
        makeLeg({ id: "a", record: OK_RECORD_A }),
        makeLeg({ id: "b", record: OK_RECORD_B_MISMATCH }),
      ).status,
    ];
    expect(alwaysMatch).not.toContain("match");
  });
});

describe("buildBaselineComparisons — 基準脚が無いときの倒れ方", () => {
  it("基準脚の artifact が無ければ、全脚が incomparable になる（match に倒れない）", () => {
    const legs = [
      makeLeg({ id: CROSS_RUNNER_BASELINE_LEG_ID, present: false }),
      makeLeg({ id: "other", record: OK_RECORD_A }),
    ];
    const { baselinePresent, comparisons } = buildBaselineComparisons(
      legs,
      CROSS_RUNNER_BASELINE_LEG_ID,
    );
    expect(baselinePresent).toBe(false);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].result.status).toBe("incomparable");
  });

  it("基準脚が在れば、他の脚それぞれと比較する", () => {
    const legs = [
      makeLeg({ id: CROSS_RUNNER_BASELINE_LEG_ID, record: OK_RECORD_A }),
      makeLeg({ id: "match-leg", record: OK_RECORD_B_MATCH }),
      makeLeg({ id: "mismatch-leg", record: OK_RECORD_B_MISMATCH }),
    ];
    const { baselinePresent, comparisons } = buildBaselineComparisons(
      legs,
      CROSS_RUNNER_BASELINE_LEG_ID,
    );
    expect(baselinePresent).toBe(true);
    const byId = Object.fromEntries(comparisons.map((c) => [c.legId, c.result.status]));
    expect(byId["match-leg"]).toBe("match");
    expect(byId["mismatch-leg"]).toBe("mismatch");
  });
});

describe("buildGroupSummaries — 群ごとの一致要約", () => {
  const legs = [
    makeLeg({
      id: "x64-a",
      runnerLabel: "ubuntu-latest",
      arch: "x64",
      numThreads: 4,
      rep: 1,
      record: OK_RECORD_A,
    }),
    makeLeg({
      id: "x64-b",
      runnerLabel: "ubuntu-22.04",
      arch: "x64",
      numThreads: 4,
      rep: 1,
      record: OK_RECORD_B_MATCH,
    }),
    makeLeg({
      id: "arm-a",
      runnerLabel: "ubuntu-24.04-arm",
      arch: "arm64",
      numThreads: 4,
      rep: 1,
      record: OK_RECORD_B_MISMATCH,
    }),
    makeLeg({
      id: "x64-a-nt1",
      runnerLabel: "ubuntu-latest",
      arch: "x64",
      numThreads: 1,
      rep: 1,
      record: OK_RECORD_A,
    }),
    makeLeg({
      id: "x64-a-rep2",
      runnerLabel: "ubuntu-latest",
      arch: "x64",
      numThreads: 4,
      rep: 2,
      record: OK_RECORD_B_MISMATCH,
    }),
  ];

  const summaries = buildGroupSummaries(legs);

  it("同 arch 内（x64 同士）はすべて比較でき、x64-a と x64-b は一致する", () => {
    expect(summaries.archInternal.comparablePairCount).toBeGreaterThan(0);
  });

  it("arch 間（x64 vs arm）の組が存在する", () => {
    expect(summaries.archCross.pairCount).toBeGreaterThan(0);
  });

  it("numThreads 間（同 runner・同 rep、numThreads だけ違う）は x64-a と x64-a-nt1 の1組だけ", () => {
    expect(summaries.numThreadsInternal.pairCount).toBe(1);
    expect(summaries.numThreadsInternal.matchCount).toBe(1); // OK_RECORD_A 同士
  });

  it("rep 間（同 runner・同 numThreads、rep だけ違う）は x64-a と x64-a-rep2 の1組だけで、不一致になる", () => {
    expect(summaries.repInternal.pairCount).toBe(1);
    expect(summaries.repInternal.allMatch).toBe(false);
  });

  it("該当する組が無い群は allMatch: null（無いことを『一致』と言わない）", () => {
    const emptyGroup = buildGroupSummaries([legs[0], legs[1]]).repInternal;
    expect(emptyGroup.pairCount).toBe(0);
    expect(emptyGroup.allMatch).toBeNull();
  });
});

describe("buildCrossRunnerSummaryMarkdown — 出力に必要な情報が全部載る", () => {
  it("欠損脚・基準脚不在・群の要約がそれぞれ Markdown に現れる", () => {
    const legs = [
      makeLeg({ id: CROSS_RUNNER_BASELINE_LEG_ID, present: false }),
      makeLeg({ id: "other", runnerLabel: "ubuntu-22.04", arch: "x64", record: OK_RECORD_A }),
    ];
    const baselineComparisons = buildBaselineComparisons(legs, CROSS_RUNNER_BASELINE_LEG_ID);
    const groupSummaries = buildGroupSummaries(legs);
    const markdown = buildCrossRunnerSummaryMarkdown({
      legs,
      baselineId: CROSS_RUNNER_BASELINE_LEG_ID,
      baselineComparisons,
      groupSummaries,
    });
    expect(markdown).toContain("artifact 無し");
    expect(markdown).toContain(CROSS_RUNNER_BASELINE_LEG_ID);
    expect(markdown).toContain("群ごとの要約");
  });
});

// buildPairwiseComparisons は buildGroupSummaries の内部でも使うが、単独の歯も持つ。
describe("buildPairwiseComparisons", () => {
  it("n件の脚から n*(n-1)/2 組を作る", () => {
    const legs = [makeLeg({ id: "a" }), makeLeg({ id: "b" }), makeLeg({ id: "c" })];
    expect(buildPairwiseComparisons(legs)).toHaveLength(3);
  });
});
