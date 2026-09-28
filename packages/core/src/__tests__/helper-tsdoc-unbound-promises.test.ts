import { describe, expect, it } from "vitest";
import type { Memory } from "../memory.js";
import { buildConsolidationPrompt } from "../strategies/consolidate.js";
import { buildReflectionPrompt } from "../strategies/reflect.js";
import {
  defaultScoringStrategy,
  isBoundedScoringStrategy,
  type ScoringStrategy,
} from "../strategies/scoring.js";

/**
 * `@mnemora/core` の公開の純関数の TSDoc が約束していて、どのテストも縛っていなかった振る舞い
 * （4回目の TSDoc の棚卸しの B8・B9）。
 */

function memory(id: string, content: string, digest: string): Memory {
  return { id, content, digest } as unknown as Memory;
}

const LONG = "長".repeat(20_000);
const memories = [
  memory("m1", "一つ目の本文", "一つ目の要旨"),
  memory("m2", LONG, "二つ目の要旨"),
  memory("m3", "三つ目の本文", "三つ目の要旨"),
];

describe("B8: buildConsolidationPrompt・buildReflectionPrompt は、全件の本文と要旨を入力の順に、切らずに並べる", () => {
  it.each([
    ["buildConsolidationPrompt", buildConsolidationPrompt],
    ["buildReflectionPrompt", buildReflectionPrompt],
  ] as const)("%s", (_name, build) => {
    const prompt = build(memories);
    expect(prompt.messages).toHaveLength(1);
    const body = prompt.messages[0]!.content;
    expect(body).toBe(
      "[1] content: 一つ目の本文\ndigest: 一つ目の要旨\n\n" +
        `[2] content: ${LONG}\ndigest: 二つ目の要旨\n\n` +
        "[3] content: 三つ目の本文\ndigest: 三つ目の要旨",
    );
  });

  it("buildReflectionPrompt の system は、共通点が無ければ outcome: 'nothing' を返してよいと明示する", () => {
    expect(buildReflectionPrompt(memories).system).toContain("outcome: 'nothing'");
    expect(buildConsolidationPrompt(memories).system).not.toContain("nothing");
  });
});

describe("B9: isBoundedScoringStrategy は nonSimilarityUpperBound を持つかで見分ける", () => {
  it("既定の戦略は true", () => {
    expect(isBoundedScoringStrategy(defaultScoringStrategy)).toBe(true);
  });

  it("nonSimilarityUpperBound を持たない戦略は false（関数でない値を持っていても false）", () => {
    const { nonSimilarityUpperBound: _dropped, ...rest } = defaultScoringStrategy;
    expect(isBoundedScoringStrategy(rest as ScoringStrategy)).toBe(false);
    expect(
      isBoundedScoringStrategy({
        ...rest,
        nonSimilarityUpperBound: 1,
      } as unknown as ScoringStrategy),
    ).toBe(false);
  });
});
