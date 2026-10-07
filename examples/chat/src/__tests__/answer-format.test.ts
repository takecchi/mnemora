import { describe, expect, it } from "vitest";
import {
  formatAnswerContentPreservation,
  formatAnswerInputReduction,
  formatAnswerIntro,
  formatAnswerQualityBanner,
} from "../answer-format.js";

describe("formatAnswerQualityBanner — 陽性対照（バナーは廃止されていない）", () => {
  it("⭐ deterministic では ⛔⛔⛔ バナーが出る（これが偽になったら、バナーが壊れている）", () => {
    const banner = formatAnswerQualityBanner("deterministic");
    expect(banner).not.toBe("");
    expect(banner).toContain("⛔⛔⛔");
    expect(banner).toContain("回答品質は測っていない");
    expect(banner).toContain("llmMode=deterministic");
  });

  it("recorded ではバナーが出ない（記録は実 API 由来なので、品質を主張してよい）", () => {
    expect(formatAnswerQualityBanner("recorded")).toBe("");
  });

  it("openai でもバナーが出ない", () => {
    expect(formatAnswerQualityBanner("openai")).toBe("");
  });
});

describe("formatAnswerInputReduction — 差の向きを読み違えない", () => {
  const results = (naiveChars: number, mnemoraChars: number) =>
    [
      {
        naive: { inputChars: naiveChars, inputEstimatedTokens: naiveChars },
        mnemora: { inputChars: mnemoraChars, inputEstimatedTokens: mnemoraChars },
      },
    ] as never;

  it("見出しに差の向き（mnemora − 全文、負なら mnemora が少ない）を書く", () => {
    const text = formatAnswerInputReduction(results(3924, 4956));
    expect(text).toContain("mnemora − 全文");
    expect(text).toContain("負なら mnemora が少ない");
    expect(text).not.toContain("削減率");
  });

  it("mnemora が多いときは +差 と「多い」", () => {
    const text = formatAnswerInputReduction(results(3924, 4956));
    expect(text).toContain("3924 → 4956");
    expect(text).toContain("+1032");
    expect(text).toContain("mnemora が 26.3% 多い");
  });

  it("mnemora が少ないときは −差 と「少ない」", () => {
    const text = formatAnswerInputReduction(results(1000, 250));
    expect(text).toContain("-750");
    expect(text).toContain("mnemora が 75.0% 少ない");
  });

  it("同じなら「同じ」", () => {
    const text = formatAnswerInputReduction(results(500, 500));
    expect(text).toContain("±0");
    expect(text).toContain("同じ");
  });
});

describe("formatAnswerIntro — 品質を主張できるかで出し分ける", () => {
  it("deterministic では「配線の検査であり、回答品質は測っていない」と言う", () => {
    const text = formatAnswerIntro("deterministic");
    expect(text).toContain("配線の検査であり、回答品質は測っていない");
  });

  it.each(["recorded", "openai"] as const)(
    "%s では「測っていない」と言わず、判定がどの LLM の回答によるかを言う",
    (mode) => {
      const text = formatAnswerIntro(mode);
      expect(text).not.toContain("回答品質は測っていない");
      expect(text).toContain(`llmMode=${mode}`);
      expect(text).toContain("正誤");
    },
  );
});

describe("formatAnswerContentPreservation: 分母は must-abstain 類を除いた件数（#699）", () => {
  const path = (applicable: boolean, preserved: boolean) =>
    ({ contentPreservation: { applicable, preserved, matchedAcceptTerms: [] } }) as never;
  const results = [
    { naive: path(true, true), mnemora: path(true, false) },
    { naive: path(true, true), mnemora: path(true, true) },
    { naive: path(false, true), mnemora: path(false, true) }, // must-abstain
  ] as never;

  it("naive 2/2・mnemora 1/2（must-abstain の1件は分母にも分子にも入らない）", () => {
    const line = formatAnswerContentPreservation(results);
    expect(line).toContain("naive 2/2 件");
    expect(line).toContain("mnemora 1/2 件");
    expect(line).toContain("分母は must-abstain 類を除いた 2 件");
  });
});
