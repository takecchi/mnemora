import { describe, expect, it } from "vitest";
import type { TokenCounter } from "../interfaces/token-counter.js";
import { findBudgetCut, unitChars, unitTokens, type BudgetUnit } from "../recall-budget-cut.js";

/**
 * ADR 0431 の確かめ直し（Issue #1734、PR #1537）で足した歯。`recall-budget-cut.test.ts` の参照実装は
 * `unitChars`・`unitTokens` を**自分で呼んでいる**ので、この2つの定義そのものが変わっても、参照実装と
 * `findBudgetCut` が一緒に動いて一致したままになる。ここでは、2つの値の定義を直接見る。
 *
 * - 文字数は digest の UTF-16 コード単位の長さ（`digest.length`）の合計。
 * - トークン数は**メンバーごと**に数えて足す（単位の digest をつなげて1回数えるのではない）。
 */

const unit = (...digests: string[]): BudgetUnit => ({
  members: digests.map((digest) => ({ memory: { digest } })),
});

/** 3文字ごとに切り上げる偽の counter。つなげて数えるのと、メンバーごとに数えて足すのとで値が変わる。 */
const ceilThirds: TokenCounter = {
  count: (text) => ({ tokens: Math.ceil(text.length / 3), counter: "heuristic" }),
};

describe("単位の文字数・トークン数の定義", () => {
  it("unitChars は UTF-16 コード単位の長さの合計（サロゲートペアは2）", () => {
    expect(unitChars(unit("😀"))).toBe(2);
    expect(unitChars(unit("ab", "😀"))).toBe(4);
  });

  it("unitTokens はメンバーごとに数えて足す", () => {
    expect(unitTokens(unit("a", "b"), ceilThirds)).toBe(2);
  });

  it("findBudgetCut：文字数の上限はコード単位で数える（絵文字1つで上限1を超える）", () => {
    expect(
      findBudgetCut([unit("😀")], { maxMemoryChars: 1, maxTokens: undefined }, ceilThirds),
    ).toBe(0);
    expect(
      findBudgetCut([unit("😀")], { maxMemoryChars: 2, maxTokens: undefined }, ceilThirds),
    ).toBe(1);
  });

  it("findBudgetCut：トークンの上限はメンバーごとの合計で数える", () => {
    expect(
      findBudgetCut([unit("a", "b")], { maxMemoryChars: undefined, maxTokens: 1 }, ceilThirds),
    ).toBe(0);
    expect(
      findBudgetCut([unit("a", "b")], { maxMemoryChars: undefined, maxTokens: 2 }, ceilThirds),
    ).toBe(1);
  });
});
