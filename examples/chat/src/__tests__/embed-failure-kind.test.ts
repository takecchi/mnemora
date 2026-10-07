import { describe, expect, it } from "vitest";
import { classifyEmbedFailureMessage } from "../embed-failure-kind.js";

// 期待する marker 文字列は逐語で書く（実装の定数を import しない。自己整合するテストにしないため）。
describe("classifyEmbedFailureMessage", () => {
  it("「上限を超えている」を含むメッセージは input_too_long", () => {
    const message =
      "LocalEmbeddingProvider: 0 番目の入力が上限を超えている(9000 トークン > 上限 8192 トークン、20000 文字)。";
    expect(classifyEmbedFailureMessage(message)).toBe("input_too_long");
  });

  it("「上限を宣言していない」を含むメッセージは unknown_input_limit", () => {
    const message =
      "LocalEmbeddingProvider: モデルが入力トークン数の上限を宣言していない(tokenizer の model_max_length = Infinity)。";
    expect(classifyEmbedFailureMessage(message)).toBe("unknown_input_limit");
  });

  it("どちらのマーカーも無ければ unknown", () => {
    expect(classifyEmbedFailureMessage("some other unrelated failure")).toBe("unknown");
    expect(classifyEmbedFailureMessage("")).toBe("unknown");
  });

  it("両方のマーカーが含まれていたら input_too_long を優先する(先に判定するほう)", () => {
    const message = "上限を超えている……上限を宣言していない";
    expect(classifyEmbedFailureMessage(message)).toBe("input_too_long");
  });
});
