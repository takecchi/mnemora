import { describe, expect, it } from "vitest";
import { detectLanguageMismatch } from "../language-mismatch.js";

// 定数を import しない: 閾値の歯が定数を下限・上限で見るだけだと、定数を1つずらしても通るため、期待値は入力の文字数・語数の数字そのもので書く。

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

describe("条件1b: 観測の（かな・漢字 + ラテン文字）のうち、かな・漢字は 0.3 から", () => {
  // かな・漢字は 6 字（東京駅で会議）。ラテン文字が 14 字なら 6/20 = 0.3、15 字なら 6/21 ≒ 0.29。
  it("0.3 ちょうどなら印が付き、それを割れば付かない", () => {
    expect(detectLanguageMismatch("東京駅で会議 meetings at noon", EN_CONTENT)).not.toBeNull();
    expect(detectLanguageMismatch("東京駅で会議 meetings at noons", EN_CONTENT)).toBeNull();
  });
});

describe("条件4: URL は数える前に除く", () => {
  // URL の外のラテン文字は 10 字（see・the・docs）。URL を数えれば 20 字を超え、小文字の語も 3 語ある。
  it("URL を除くと 20 字に届かない本文は陰性（http も HTTPS も大文字小文字によらず除く）", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "see the docs https://example.com/getting-started"),
    ).toBeNull();
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "see the docs HTTPS://example.com/getting-started"),
    ).toBeNull();
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "see the docs Http://example.com/getting-started"),
    ).toBeNull();
  });

  it("対照: 同じ文字を URL にしなければ印が付く", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "see the docs example com getting started"),
    ).not.toBeNull();
  });
});

describe("条件6 の LOWERCASE_WORD: 語末の記号", () => {
  // 小文字の語はどれも語末に記号が付いている。記号付きの語を数えなければ 0 語になる。
  it("語末の , . は1語に数える（visited・enjoyed・loved の 3 語で印が付く）", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "Tokyo Disneyland Resort: visited, enjoyed, loved."),
    ).not.toBeNull();
  });

  it("語末の ! ? ; : も1語に数える", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "Tokyo Disneyland Resort loved! really? yes; wow:"),
    ).not.toBeNull();
  });
});
