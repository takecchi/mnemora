import { describe, expect, it } from "vitest";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";

// 省略時の既定は変えない（temperature は省略なら渡さない）。

const client = {} as never;

const badDimensions: [string, unknown][] = [
  ["0", 0],
  ["負", -1],
  ["小数 1.5", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Infinity],
  ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
  ["文字列 '256'", "256"],
  ["undefined（必須）", undefined],
  ["null", null],
];

describe("OpenAIEmbeddingProvider: dimensions を構築時に検査する（ADR 0498）", () => {
  it.each(badDimensions)("dimensions が %s なら構築時に投げる", (_l, value) => {
    expect(
      () => new OpenAIEmbeddingProvider({ client, model: "m", dimensions: value as never }),
    ).toThrow(/OpenAIEmbeddingProvider: dimensions must be a positive safe integer/);
  });

  it("型が違うと TypeError、数として不正だと RangeError、message に値が入る", () => {
    const make = (d: unknown) =>
      new OpenAIEmbeddingProvider({ client, model: "m", dimensions: d as never });
    expect(() => make("256")).toThrow(TypeError);
    expect(() => make(-7)).toThrow(RangeError);
    expect(() => make(-7)).toThrow(/got -7/);
  });

  it.each([
    ["1（下限）", 1],
    ["256", 256],
    ["3072", 3072],
    ["MAX_SAFE_INTEGER（上限）", Number.MAX_SAFE_INTEGER],
  ])("dimensions が %s なら通り、space.dimensions に入る", (_l, value) => {
    const p = new OpenAIEmbeddingProvider({ client, model: "m", dimensions: value });
    expect(p.space.dimensions).toBe(value);
  });
});

describe("OpenAILLMProvider: temperature を構築時に検査する（ADR 0498）", () => {
  it.each([
    ["負", -0.1],
    ["-Infinity", -Infinity],
    ["Infinity", Infinity],
    ["NaN", Number.NaN],
    ["文字列 '0.5'", "0.5"],
    ["null", null],
  ])("temperature が %s なら構築時に投げる", (_l, value) => {
    expect(
      () => new OpenAILLMProvider({ client, model: "m", temperature: value as never }),
    ).toThrow(/OpenAILLMProvider: temperature must be a finite number >= 0/);
  });

  it("型が違うと TypeError、数として不正だと RangeError", () => {
    expect(() => new OpenAILLMProvider({ client, model: "m", temperature: "1" as never })).toThrow(
      TypeError,
    );
    expect(() => new OpenAILLMProvider({ client, model: "m", temperature: -1 })).toThrow(
      RangeError,
    );
  });

  it.each([
    ["0（下限）", 0],
    ["0.7", 0.7],
    ["2", 2],
    ["5（上限は見ない）", 5],
    ["省略", undefined],
  ])("temperature が %s なら通る", (_l, value) => {
    expect(() => new OpenAILLMProvider({ client, model: "m", temperature: value })).not.toThrow();
  });
});
