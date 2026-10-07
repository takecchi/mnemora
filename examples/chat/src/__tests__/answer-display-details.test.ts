import { describe, expect, it } from "vitest";
import { formatAnswerInputReduction, formatAnswerIntro } from "../answer-format.js";
import { computeInputReduction } from "../answer-json.js";

// 見出し・向き・+/- の符号は answer-format.test.ts が見る。ここは、そこから漏れる列（tokens）・出所の言い方・JSON 側の向きを見る。

const results = (chars: [number, number], tokens: [number, number]) =>
  [
    {
      naive: { inputChars: chars[0], inputEstimatedTokens: tokens[0] },
      mnemora: { inputChars: chars[1], inputEstimatedTokens: tokens[1] },
    },
  ] as never;

describe("formatAnswerInputReduction — chars と tokens を取り違えない", () => {
  it("chars と tokens が別の値のとき、それぞれの合計・差・割合を、自分の列に出す", () => {
    const text = formatAnswerInputReduction(results([3924, 4956], [1000, 400]));
    expect(text).toContain("chars 3924 → 4956（+1032、mnemora が 26.3% 多い）");
    expect(text).toContain("tokens(概算) 1000 → 400（-600、mnemora が 60.0% 少ない）");
  });
});

describe("computeInputReduction — JSON の割合は (naive - mnemora) / naive のまま（正なら mnemora が少ない）", () => {
  it("mnemora が少ないと正、多いと負、naive が 0 なら 0", () => {
    const fewer = computeInputReduction(results([1000, 250], [200, 50]));
    expect(fewer.charReductionRatio).toBeCloseTo(0.75);
    expect(fewer.tokenReductionRatio).toBeCloseTo(0.75);

    const more = computeInputReduction(results([1000, 1500], [200, 300]));
    expect(more.charReductionRatio).toBeCloseTo(-0.5);
    expect(more.tokenReductionRatio).toBeCloseTo(-0.5);

    const empty = computeInputReduction(results([0, 10], [0, 10]));
    expect(empty.charReductionRatio).toBe(0);
    expect(empty.tokenReductionRatio).toBe(0);
  });
});

describe("formatAnswerIntro — 出し分けの中身", () => {
  it("deterministic の文は、どのモードで走ったかを名乗り、判定の主張をしない", () => {
    const text = formatAnswerIntro("deterministic");
    expect(text).toContain("（llmMode=deterministic）");
    expect(text).not.toContain("一般的な回答品質の保証ではない");
  });

  it("recorded は記録の再生だと言い、openai は再生と言わない", () => {
    expect(formatAnswerIntro("recorded")).toContain(
      "llmMode=recorded: 記録した時点の実 API の回答の再生",
    );
    const openai = formatAnswerIntro("openai");
    expect(openai).toContain("llmMode=openai: 実 API の回答");
    expect(openai).not.toContain("再生");
  });

  it.each(["recorded", "openai"] as const)(
    "%s の判定は、このケース集合に対するもので、一般的な品質の保証ではないと断る",
    (mode) => {
      expect(formatAnswerIntro(mode)).toContain("一般的な回答品質の保証ではない");
    },
  );
});
