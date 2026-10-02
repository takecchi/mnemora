import { describe, expect, it } from "vitest";
import { AnthropicLLMProvider } from "../llm-provider.js";

// ADR 0498: maxTokens は構築時に検査する（正の安全な整数）。省略時の既定（DEFAULT_MAX_TOKENS）は変えない。
// `temperature` の欄はこの provider に無い。

const client = {} as never;

describe("AnthropicLLMProvider: maxTokens を構築時に検査する（ADR 0498）", () => {
  it.each([
    ["0", 0],
    ["負", -1],
    ["小数 1.5", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Infinity],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
    ["文字列 '1024'", "1024"],
    ["null", null],
  ])("maxTokens が %s なら構築時に投げる", (_l, value) => {
    expect(
      () => new AnthropicLLMProvider({ client, model: "m", maxTokens: value as never }),
    ).toThrow(/AnthropicLLMProvider: maxTokens must be a positive safe integer/);
  });

  it("型が違うと TypeError、数として不正だと RangeError、message に値が入る", () => {
    const make = (v: unknown) =>
      new AnthropicLLMProvider({ client, model: "m", maxTokens: v as never });
    expect(() => make("1")).toThrow(TypeError);
    expect(() => make(0)).toThrow(RangeError);
    expect(() => make(-7)).toThrow(/got -7/);
  });

  it.each([
    ["1（下限）", 1],
    ["1024", 1024],
    ["64000", 64000],
    ["MAX_SAFE_INTEGER（上限）", Number.MAX_SAFE_INTEGER],
    ["省略（既定）", undefined],
  ])("maxTokens が %s なら通る", (_l, value) => {
    expect(() => new AnthropicLLMProvider({ client, model: "m", maxTokens: value })).not.toThrow();
  });
});
