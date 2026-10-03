import { describe, expect, it } from "vitest";
import { truncateForFallbackDigest } from "../extraction.js";
import { computeAffinity } from "../strategies/consolidate.js";
import {
  compareScoredCandidates,
  countKindForUnits,
  unitAssemblyShortfall,
  type Unit,
} from "../recall-runtime.js";
import type { ScoreBreakdown } from "../recall.js";

type ScoredCandidate = Parameters<typeof compareScoredCandidates>[0];

/**
 * 公開の純関数の TSDoc の約束を、実装が守っていなかった4か所の歯（4回目の TSDoc の棚卸しの C1〜C4）。
 */

function candidate(id: string, recordedAt: Date, total = 1): ScoredCandidate {
  return {
    memory: { id, recordedAt, occurredAt: null, digest: "d" },
    score: { total },
  } as unknown as ScoredCandidate;
}

describe("C1 truncateForFallbackDigest: 負の maxLength は上限0として扱う（本文が空のときも）", () => {
  it.each([
    ["", "（内容なし）"],
    ["   ", "（内容なし）"],
    ["abc", "…"],
  ])("%j: maxLength -1 は maxLength 0 と同じ結果（%s）", (content, expected) => {
    expect(truncateForFallbackDigest(content, 0)).toBe(expected);
    expect(truncateForFallbackDigest(content, -1)).toBe(expected);
    expect(truncateForFallbackDigest(content, -100)).toBe(expected);
  });

  it("正の maxLength はこれまでどおり（本文が収まれば切らず、超えれば切って … を付ける）", () => {
    expect(truncateForFallbackDigest("abc", 3)).toBe("abc");
    expect(truncateForFallbackDigest("abcd", 3)).toBe("abc…");
    expect(truncateForFallbackDigest("", 3)).toBe("（内容なし）");
  });
});

describe("C2 computeAffinity: similarity が NaN なら無いものとして lexicalMatch を使う", () => {
  it("similarity が NaN、lexicalMatch が 0.2 なら 0.2", () => {
    expect(
      computeAffinity({ total: 1, similarity: NaN, lexicalMatch: 0.2 } as ScoreBreakdown),
    ).toBe(0.2);
  });

  it("similarity が NaN で lexicalMatch も無ければ -Infinity（どの minAffinity でも落ちる）", () => {
    expect(computeAffinity({ total: 1, similarity: NaN } as ScoreBreakdown)).toBe(-Infinity);
  });

  it("有限の similarity と lexicalMatch は、今までどおり大きいほう", () => {
    expect(
      computeAffinity({ total: 1, similarity: 0.7, lexicalMatch: 0.2 } as ScoreBreakdown),
    ).toBe(0.7);
    expect(
      computeAffinity({ total: 1, similarity: 0.1, lexicalMatch: 0.2 } as ScoreBreakdown),
    ).toBe(0.2);
    expect(computeAffinity({ total: 1 } as ScoreBreakdown)).toBe(-Infinity);
  });
});

describe("C3 countKindForUnits・unitAssemblyShortfall: 件数ではなく候補の id の集合で確かめる", () => {
  const a = candidate("a", new Date(0));
  const b = candidate("b", new Date(0));
  const c = candidate("c", new Date(0));
  const units = (...groups: ScoredCandidate[][]): Unit[] =>
    groups.map((members) => ({ members, rankScore: 1 }));

  it("1件が二重に入り、別の1件が抜けている（件数だけは合う）と、'unknown' で、抜けた1件を数える", () => {
    const assembled = units([a], [a, b]);
    expect(countKindForUnits(assembled, 3)).toBe("unknown");
    expect(unitAssemblyShortfall(assembled, 3)).toBe(1);
  });

  it("覆えていれば 'exact' と 0（今までどおり）", () => {
    const assembled = units([a], [b, c]);
    expect(countKindForUnits(assembled, 3)).toBe("exact");
    expect(unitAssemblyShortfall(assembled, 3)).toBe(0);
  });

  it("二重計上だけ（抜けは無い）は 'unknown' と 0（今までどおり。落ちたと名乗らない）", () => {
    const assembled = units([a], [a, b], [c]);
    expect(countKindForUnits(assembled, 3)).toBe("unknown");
    expect(unitAssemblyShortfall(assembled, 3)).toBe(0);
  });

  it("抜けだけ（二重は無い）は 'unknown' と抜けた件数（今までどおり）", () => {
    const assembled = units([a]);
    expect(countKindForUnits(assembled, 3)).toBe("unknown");
    expect(unitAssemblyShortfall(assembled, 3)).toBe(2);
  });

  it("異なる id の数が候補数を超えている（二重は無い）と、'unknown' で、抜けた件数は 0（差の絶対値ではない）", () => {
    const assembled = units([a], [b, c]);
    expect(countKindForUnits(assembled, 2)).toBe("unknown");
    expect(unitAssemblyShortfall(assembled, 2)).toBe(0);
  });
});

describe("C4 compareScoredCandidates: Invalid Date の時刻でも NaN を返さず、id のタイブレークで決める", () => {
  const invalid = candidate("b", new Date(NaN));
  const valid = candidate("a", new Date(1));

  it("片方の時刻が Invalid Date でも、比較は NaN にならず id の昇順で決まる", () => {
    expect(Number.isNaN(compareScoredCandidates(invalid, valid))).toBe(false);
    expect(compareScoredCandidates(valid, invalid)).toBeLessThan(0);
    expect(compareScoredCandidates(invalid, valid)).toBeGreaterThan(0);
  });

  it("Invalid Date が id の小さいほうに付いていても（逆の組）、id の昇順で決まる（Invalid Date を後ろへ送らない）", () => {
    const invalidFirstById = candidate("a", new Date(NaN));
    const validLaterById = candidate("b", new Date(1));
    expect(compareScoredCandidates(invalidFirstById, validLaterById)).toBeLessThan(0);
    expect(compareScoredCandidates(validLaterById, invalidFirstById)).toBeGreaterThan(0);
    expect(
      [validLaterById, invalidFirstById].sort(compareScoredCandidates).map((x) => x.memory.id),
    ).toEqual(["a", "b"]);
  });

  it("両方 Invalid Date でも id の昇順で決まる", () => {
    const x = candidate("x", new Date(NaN));
    const y = candidate("y", new Date(NaN));
    expect(compareScoredCandidates(x, y)).toBeLessThan(0);
    expect(compareScoredCandidates(y, x)).toBeGreaterThan(0);
  });

  it("有効な時刻どうしは、今までどおり新しいほうが先（id より時刻が優先）", () => {
    const older = candidate("a", new Date(1));
    const newer = candidate("z", new Date(2));
    expect(compareScoredCandidates(newer, older)).toBeLessThan(0);
  });

  it("sort に使うと、Invalid Date を含んでも id の順に決まる", () => {
    const list = [
      candidate("c", new Date(NaN)),
      candidate("a", new Date(NaN)),
      candidate("b", new Date(NaN)),
    ];
    expect([...list].sort(compareScoredCandidates).map((x) => x.memory.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
