import { describe, expect, it } from "vitest";
import {
  countKindForPartition,
  countKindForUnits,
  partitionByThreshold,
} from "../recall-runtime.js";
import type { ScoreBreakdown } from "../recall.js";

/**
 * 段2の閾値比較を、網羅的な三分割にしたこと（ADR 0044）の歯。
 *
 * **以前は `filter(total >= t)` と `filter(total < t)` の2本を独立に走らせていた。
 * この2つは補集合ではない**——どちらかが `NaN` だと両方の比較が false になり、
 * 候補は残らないのに `below_threshold` にも数えられなかった。
 */

/** `ScoredCandidate` の最小の作り。`score.total` 以外はこの検査の対象ではない。 */
function candidate(id: string, total: number) {
  const score: ScoreBreakdown = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total };
  return { memory: { id }, retrievedVia: "ann", score } as unknown as Parameters<
    typeof partitionByThreshold
  >[0][number];
}

function ids(list: { memory: { id: string } }[]): string[] {
  return list.map((c) => c.memory.id);
}

describe("partitionByThreshold（ADR 0044）", () => {
  it("閾値以上・閾値未満・比較が決まらない、の3つに分ける", () => {
    // ⚠ 件数を 2 / 3 / 1 と互いに違える。同数だと束ねても取り違えても同じ数が出る。
    const scored = [
      candidate("pass-1", 0.9),
      candidate("pass-2", 0.1), // 閾値ちょうどは「以上」側
      candidate("below-1", 0.09),
      candidate("below-2", 0),
      candidate("below-3", -1),
      candidate("nan-1", Number.NaN),
    ];
    const p = partitionByThreshold(scored, 0.1);
    expect(ids(p.passed)).toEqual(["pass-1", "pass-2"]);
    expect(ids(p.belowThreshold)).toEqual(["below-1", "below-2", "below-3"]);
    expect(ids(p.notComparable)).toEqual(["nan-1"]);
  });

  it("🔴 三分割は網羅である（合計が入力の件数と一致する）", () => {
    const scored = [
      candidate("a", 0.5),
      candidate("b", Number.NaN),
      candidate("c", -0.5),
      candidate("d", Number.NaN),
    ];
    const p = partitionByThreshold(scored, 0.1);
    expect(p.passed.length + p.belowThreshold.length + p.notComparable.length).toBe(scored.length);
    // NaN が2件あることまで見る（1件だけ拾う実装を弾く）。
    expect(p.notComparable).toHaveLength(2);
  });

  it("⚠ 閾値そのものが NaN なら、全件が notComparable に入る", () => {
    // zod は scoreThreshold: NaN を弾くので `recall()` からは到達しないが、
    // 純関数としてはこの入力が来うる。**分割が網羅であることは閾値に依らない。**
    const scored = [candidate("a", 0.9), candidate("b", 0), candidate("c", Number.NaN)];
    const p = partitionByThreshold(scored, Number.NaN);
    expect(p.passed).toHaveLength(0);
    expect(p.belowThreshold).toHaveLength(0);
    expect(p.notComparable).toHaveLength(3);
  });

  it("⚠ 鳴ってはいけない側: NaN が無ければ notComparable は空", () => {
    const scored = [
      candidate("a", 0.9),
      candidate("b", 0.1),
      candidate("c", 0),
      candidate("d", -1),
    ];
    const p = partitionByThreshold(scored, 0.1);
    expect(p.notComparable).toEqual([]);
    expect(p.passed.length + p.belowThreshold.length).toBe(4);
  });

  it("Infinity は比較が決まる（notComparable に入れない）", () => {
    const p = partitionByThreshold(
      [
        candidate("posinf", Number.POSITIVE_INFINITY),
        candidate("neginf", Number.NEGATIVE_INFINITY),
        candidate("negzero", -0),
      ],
      0.1,
    );
    expect(ids(p.passed)).toEqual(["posinf"]);
    expect(ids(p.belowThreshold)).toEqual(["neginf", "negzero"]);
    expect(p.notComparable).toEqual([]);
  });

  it("入力が0件なら3つとも空（網羅は保たれる）", () => {
    const p = partitionByThreshold([], 0.1);
    expect(p.passed).toEqual([]);
    expect(p.belowThreshold).toEqual([]);
    expect(p.notComparable).toEqual([]);
  });
});

describe("countKindForPartition（ADR 0044）", () => {
  // **🔴 到達不能な分岐の「前提そのもの」を測る歯である。**
  // `partitionByThreshold` が正しい限り 'unknown' 側は recall() から到達しない。
  // ⟹ 到達しないことを理由に測らないでいると、`'exact'` をリテラルで書き戻す変更が
  //    素通りする（実際、この関数へ切り出す前はその変異が生き残った）。
  function part(passed: number, below: number, notComparable: number) {
    const fill = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => candidate(`${tag}-${i}`, 0));
    return {
      passed: fill(passed, "p"),
      belowThreshold: fill(below, "b"),
      notComparable: fill(notComparable, "n"),
    };
  }

  it("三分割が網羅なら 'exact' と名乗る", () => {
    expect(countKindForPartition(part(2, 3, 1), 6)).toBe("exact");
  });

  it("🔴 網羅でなければ 'unknown' へ落ちる（嘘をつくのではなく黙る）", () => {
    // 1件どこにも入っていない分割。
    expect(countKindForPartition(part(2, 3, 0), 6)).toBe("unknown");
  });

  it("🔴 数えすぎ（同じ候補を二重に入れた分割）でも 'unknown' へ落ちる", () => {
    expect(countKindForPartition(part(2, 3, 2), 6)).toBe("unknown");
  });

  it("0件どうしは網羅（'exact'）", () => {
    expect(countKindForPartition(part(0, 0, 0), 0)).toBe("exact");
  });
});

describe("countKindForUnits（ADR 0045）", () => {
  // **🔴 段2でやったのと同じ形——到達不能な分岐の「前提そのもの」を測る歯である。**
  // 単位を組む繰り返しが正しい限り 'unknown' 側は recall() から到達しない。
  // ⟹ 到達しないことを理由に測らないでいると、`'exact'` をリテラルで書き戻す変更が
  //    素通りする（段2ではまさにそれが起きた）。
  //
  // ⚠ ここで測っているのは `slice` の網羅性ではない。それは言語の保証であり同語反復になる。
  //    測っているのは「候補がそれぞれちょうど1つの単位に入ったか」という、
  //    単位を組む繰り返しの性質である。
  function units(...memberCounts: number[]) {
    return memberCounts.map((n) => ({
      members: Array.from({ length: n }, (_, i) => candidate(`m-${i}`, 0)),
      rankScore: 0,
    }));
  }

  it("単位が候補を網羅していれば 'exact' と名乗る", () => {
    // 単位の形も非対称にする（1件の単位2つ・2件の同伴ペア1つ = 候補4件）。
    expect(countKindForUnits(units(1, 2, 1), 4)).toBe("exact");
  });

  it("🔴 候補が1件どの単位にも入っていなければ 'unknown' へ落ちる（嘘をつくのではなく黙る）", () => {
    // 候補5件のうち4件しか単位に入っていない＝1件が消えている。
    expect(countKindForUnits(units(1, 2, 1), 5)).toBe("unknown");
  });

  it("🔴 同じ候補が二重に単位へ入っていても 'unknown' へ落ちる", () => {
    expect(countKindForUnits(units(1, 2, 1, 1), 4)).toBe("unknown");
  });

  it("候補も単位も0なら網羅（'exact'）", () => {
    expect(countKindForUnits([], 0)).toBe("exact");
  });
});
