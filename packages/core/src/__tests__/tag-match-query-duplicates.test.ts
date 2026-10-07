import { describe, expect, it } from "vitest";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/**
 * `tagMatch = 1 + 0.1 × m`。`m` はクエリの `tags` の要素ごとに、記憶の `tags` に完全一致で含まれるかを数えた数で、
 * クエリ側の重複は重複のまま数える。記憶側の重複は1回に数える。
 * これは「約束」ではなく今の振る舞いの記録である（重複を1つに数えるよう改めると、重複したクエリタグを渡している呼び出し側の順位が変わる）。
 * 変えるときは、この歯を意図して書き換えること。
 */
function tagMatch(memoryTags: string[], queryTags: string[]): number {
  const recordedAt = new Date("2026-01-01T00:00:00.000Z");
  return defaultScoringStrategy({
    now: recordedAt,
    tags: memoryTags,
    queryTags,
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
  }).tagMatch;
}

function upperBound(queryTags: string[]): number {
  const bound = defaultScoringStrategy.nonSimilarityUpperBound({ queryTags });
  if (bound.kind !== "declared") throw new Error("bound must be declared");
  return bound.value;
}

describe("tagMatch の数え方（ADR 0474）", () => {
  it("陽性対照: 一致1つは 1.1、一致なし・クエリなし・記憶のタグなしは 1", () => {
    expect(tagMatch(["a"], ["a"])).toBeCloseTo(1.1, 10);
    expect(tagMatch(["a"], ["b"])).toBe(1);
    expect(tagMatch(["a"], [])).toBe(1);
    expect(tagMatch([], ["a"])).toBe(1);
  });

  it("クエリ側の重複は重複のまま数える", () => {
    expect(tagMatch(["a"], ["a", "a"])).toBeCloseTo(1.2, 10);
    expect(tagMatch(["a"], ["a", "a", "a"])).toBeCloseTo(1.3, 10);
    expect(tagMatch(["a", "b"], ["a", "b", "a"])).toBeCloseTo(1.3, 10);
  });

  it("記憶側の重複は1回に数える", () => {
    expect(tagMatch(["a", "a"], ["a"])).toBeCloseTo(1.1, 10);
  });

  it("完全一致である（大文字小文字・前後の空白は別の語。空文字は語として一致する）", () => {
    expect(tagMatch(["a"], ["A"])).toBe(1);
    expect(tagMatch(["a"], [" a"])).toBe(1);
    expect(tagMatch([""], [""])).toBeCloseTo(1.1, 10);
    expect(tagMatch(["a"], [""])).toBe(1);
  });

  it("上界 1 + 0.1 × クエリタグ数は、重複を数えた tagMatch を下回らない（ANN の打ち切りの健全性）", () => {
    const memories = [[], ["a"], ["a", "b"], ["a", "a", "b"], [""], ["A"]];
    const queries = [[], ["a"], ["a", "a"], ["a", "a", "a"], ["a", "b", "a"], ["", ""], ["A", "a"]];
    for (const memoryTags of memories) {
      for (const queryTags of queries) {
        expect(tagMatch(memoryTags, queryTags)).toBeLessThanOrEqual(upperBound(queryTags) + 1e-12);
      }
    }
    expect(upperBound(["a", "a", "a"])).toBeCloseTo(1.3, 10);
  });
});
