import { describe, expect, it } from "vitest";
import { detectLanguageMismatch } from "../language-mismatch.js";

/**
 * 言語の事後検査の規則の境目を、すぐ内側とすぐ外側の対で縛る（ADR 0554 の条件1a・4・6 と、
 * 条件6の `LOWERCASE_WORD` の直引用符の扱い）。
 *
 * `language-mismatch.test.ts` の閾値の歯は定数を下限・上限で見るだけで、定数を1つずらしても通っていた。
 * ここでは**定数を import しない**——期待値は入力の文字数・語数の数字そのもので書く。
 * どの対も、見たい条件のほかはすべて余裕をもって満たす入力にしてある。
 */

/** かな・漢字が十分にあり、ラテン文字が無い観測（条件1a・1b を余裕で満たす）。 */
const JA_OBSERVATION = "今日は渋谷のパン屋で働いています。毎朝パンを焼くのが好きです。";
/** 条件2〜6 を余裕で満たす本文。 */
const EN_CONTENT = "The user works at a bakery in Shibuya and enjoys baking bread every morning.";

describe("条件1a: 観測のかな・漢字は 4 字から", () => {
  it("4 字なら印が付き、3 字なら付かない", () => {
    expect(detectLanguageMismatch("東京駅で", EN_CONTENT)).not.toBeNull();
    expect(detectLanguageMismatch("東京駅", EN_CONTENT)).toBeNull();
  });
});

describe("条件4: 本文のラテン文字は 20 字から", () => {
  // 小文字の語だけ（条件6 を余裕で満たす）、割合は 1（条件5）。
  const LETTERS_20 = "we are going to the parks";
  const LETTERS_19 = "we are going to the park";

  it("20 字なら印が付き、19 字なら付かない", () => {
    const mark = detectLanguageMismatch(JA_OBSERVATION, LETTERS_20);
    expect(mark).not.toBeNull();
    expect(mark?.contentLatinLetters).toBe(20);
    expect(detectLanguageMismatch(JA_OBSERVATION, LETTERS_19)).toBeNull();
  });
});

describe("条件6: 小文字の語は 3 語から", () => {
  // どちらもラテン文字は 20 字を十分に超える。違うのは `Is` の大文字だけ。
  it("3 語（is・very・busy）なら印が付き、2 語（very・busy）なら付かない", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "Tokyo Station Meeting Room is very busy"),
    ).not.toBeNull();
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "Tokyo Station Meeting Room Is very busy"),
    ).toBeNull();
  });
});

describe("条件6 の LOWERCASE_WORD: 直引用符の語の扱い", () => {
  it("語の中の ASCII の ' は1語に数える（doesn't・like・it の 3 語で印が付く）", () => {
    expect(detectLanguageMismatch(JA_OBSERVATION, "Kenji Tanaka doesn't like it")).not.toBeNull();
  });

  it("’（U+2019）の語は数えない（like・it の 2 語で付かない）", () => {
    expect(detectLanguageMismatch(JA_OBSERVATION, "Kenji Tanaka doesn’t like it")).toBeNull();
  });

  it("' が2つある語は数えない（likes・music の 2 語で付かない）", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "Kenji Tanaka likes rock'n'roll music"),
    ).toBeNull();
  });

  it('" で囲んだ語は数えない（replied・and の 2 語で付かない）。囲みを外せば付く', () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, 'Kenji replied "works fine" and "sounds good"'),
    ).toBeNull();
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "Kenji replied works fine and sounds good"),
    ).not.toBeNull();
  });
});
