import { describe, expect, it } from "vitest";
import { compareScoredCandidates } from "../recall-runtime.js";
import type { Memory } from "../memory.js";
import type { ScoreBreakdown } from "../recall.js";

/**
 * `recall-runtime.ts` の非 export な `compareDescendingNaNLast` の複製（意図的に export
 * していない——公開 API 表面を1シンボルも増やさないため、Issue #938 の修正は
 * `pnpm api:check` の差分を0のままにする）。`compareScoredCandidates`（段2、下の
 * describe で直接検査）・`associationHits.sort`（段3.5、アンカー類似度降順）・
 * `rankedCandidates.sort`（段3.5、rankKey 降順）の3箇所が同じ実装を共有している。
 * 段3.5の2箇所は private な関数の直接 import では検査できないため、ここでは
 * その形（数値2つを受けて降順・NaN 最後尾を返す）だけを単体で確かめる——
 * 本体（`recall-runtime.ts`）を変更したら、この複製も合わせて直すこと。
 */
function compareDescendingNaNLast(a: number, b: number): number {
  const aComparable = !Number.isNaN(a);
  const bComparable = !Number.isNaN(b);
  if (!aComparable || !bComparable) {
    return aComparable === bComparable ? 0 : aComparable ? -1 : 1;
  }
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/**
 * Issue #938（ADR 0040「引き受ける負債」への反例）: `total` が `NaN` の候補が1件でも
 * 混ざると、`compareScoredCandidates`（段2の並べ替え）は `NaN` と無関係な有限候補
 * どうしの相対順序まで壊す。`b.score.total - a.score.total` は NaN を挟むと
 * 比較関数の一貫性（推移律）を満たさなくなり、`Array.prototype.sort` の結果が
 * 未定義動作になるため。
 */
function candidate(id: string, total: number, recordedAt: Date) {
  return {
    memory: { id, recordedAt, occurredAt: null } as unknown as Memory,
    retrievedVia: "ann" as const,
    score: { total } as unknown as ScoreBreakdown,
  };
}

describe("compareScoredCandidates: NaN な total が混ざっても有限候補の順序を壊さない（Issue #938）", () => {
  const t = new Date("2026-01-01T00:00:00.000Z");

  it("陽性対照: NaN が無ければ total 降順に正しく並ぶ", () => {
    const items = [
      candidate("B", 0.8, t),
      candidate("D", 0.6, t),
      candidate("A", 0.9, t),
      candidate("E", 0.5, t),
      candidate("C", 0.7, t),
    ];
    const sorted = [...items].sort(compareScoredCandidates);
    expect(sorted.map((c) => c.memory.id)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("Issue #938 の再現そのもの: A(0.9), C(0.7), NaN, B(0.8) の並びでも有限候補は A,B,C の順のまま", () => {
    const input = [
      candidate("A", 0.9, t),
      candidate("C", 0.7, t),
      candidate("NAN1", NaN, t),
      candidate("B", 0.8, t),
    ];
    const sorted = [...input].sort(compareScoredCandidates);
    const finiteOrder = sorted
      .filter((c) => Number.isFinite(c.score.total))
      .map((c) => c.memory.id);
    expect(finiteOrder).toEqual(["A", "B", "C"]);
  });

  it("複数の NaN・複数の配置を総当たりしても、有限候補の相対順序は total 降順のまま崩れない", () => {
    const base = [
      candidate("A", 0.9, t),
      candidate("B", 0.8, t),
      candidate("C", 0.7, t),
      candidate("D", 0.6, t),
      candidate("NAN1", NaN, t),
      candidate("NAN2", NaN, t),
    ];

    function permutations<T>(arr: T[]): T[][] {
      if (arr.length <= 1) return [arr];
      const result: T[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const head = arr[i]!;
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) result.push([head, ...p]);
      }
      return result;
    }

    for (const perm of permutations(base)) {
      const sorted = [...perm].sort(compareScoredCandidates);
      const finiteOrder = sorted
        .filter((c) => Number.isFinite(c.score.total))
        .map((c) => c.memory.id);
      expect(finiteOrder).toEqual(["A", "B", "C", "D"]);
    }
  });

  it("NaN どうしは同点として扱われ、次段のタイブレーク（実効時刻→id）へ進む", () => {
    const newer = new Date(t.getTime() + 1000);
    const older = t;
    const nanNewer = candidate("NAN-NEW", NaN, newer);
    const nanOlder = candidate("NAN-OLD", NaN, older);
    const sorted = [nanOlder, nanNewer].sort(compareScoredCandidates);
    // 実効時刻降順（新しい方が先）——total が両方 NaN でも、既存のタイブレークが効く。
    expect(sorted.map((c) => c.memory.id)).toEqual(["NAN-NEW", "NAN-OLD"]);
  });
});

/**
 * `compareDescendingNaNLast`（recall-runtime.ts）は、段2の `compareScoredCandidates` と
 * 段3.5の2つの sort（`associationHits.sort` — アンカー類似度降順、`rankedCandidates.sort`
 * — rankKey 降順）が共有する比較 helper（Issue #938）。`similarity`/`rankKey` は
 * ゼロベクトルの cosine 距離（ADR 0040）に由来して `NaN` になりうるため、単体でも検査する。
 */
describe("compareDescendingNaNLast（段2・段3.5で共有する比較 helper。Issue #938）", () => {
  it("有限値どうしは通常の降順", () => {
    expect(compareDescendingNaNLast(0.9, 0.5)).toBeLessThan(0);
    expect(compareDescendingNaNLast(0.5, 0.9)).toBeGreaterThan(0);
    expect(compareDescendingNaNLast(0.5, 0.5)).toBe(0);
  });

  it("NaN は有限値より必ず後ろに送る（どちら側に来ても）", () => {
    expect(compareDescendingNaNLast(NaN, 0.1)).toBeGreaterThan(0);
    expect(compareDescendingNaNLast(0.1, NaN)).toBeLessThan(0);
    expect(compareDescendingNaNLast(NaN, -100)).toBeGreaterThan(0);
  });

  it("NaN どうしは 0（呼び出し側の次段のタイブレーク・安定ソートに委ねる）", () => {
    expect(compareDescendingNaNLast(NaN, NaN)).toBe(0);
  });
});

/**
 * 段3.5（連想）の2つの sort が実際に `compareDescendingNaNLast` を使っている形
 * （`recall-runtime.ts` の `associationHits.sort`/`rankedCandidates.sort` と同じ呼び方）で、
 * `similarity`/`rankKey` に `NaN` が混ざっても有限候補の相対順序が崩れないことを確かめる。
 */
describe("段3.5: associationHits/rankedCandidates と同じ sort の形が NaN 混入でも有限候補の順序を壊さない（Issue #938）", () => {
  it("similarity 相当の値に NaN が混ざっても有限候補は降順のまま（associationHits.sort と同形）", () => {
    const items = [
      { id: "A", similarity: 0.9 },
      { id: "C", similarity: 0.7 },
      { id: "NAN1", similarity: NaN },
      { id: "B", similarity: 0.8 },
    ];
    const sorted = [...items].sort((a, b) => compareDescendingNaNLast(a.similarity, b.similarity));
    const finiteOrder = sorted.filter((x) => Number.isFinite(x.similarity)).map((x) => x.id);
    expect(finiteOrder).toEqual(["A", "B", "C"]);
  });

  it("rankKey 相当の値に NaN が混ざっても有限候補は降順のまま（rankedCandidates.sort と同形）", () => {
    const items = [
      { id: "A", rankKey: 0.81 },
      { id: "C", rankKey: 0.49 },
      { id: "NAN1", rankKey: NaN },
      { id: "B", rankKey: 0.64 },
    ];
    const sorted = [...items].sort((a, b) => compareDescendingNaNLast(a.rankKey, b.rankKey));
    const finiteOrder = sorted.filter((x) => Number.isFinite(x.rankKey)).map((x) => x.id);
    expect(finiteOrder).toEqual(["A", "B", "C"]);
  });
});
