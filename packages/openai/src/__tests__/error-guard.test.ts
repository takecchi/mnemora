import { describe, expect, it } from "vitest";
import { OpenAILLMProviderError, isOpenAILLMProviderError } from "../errors.js";

/** ADR 0428 / ADR 0418: `instanceof` を使わず「`kind`、無ければ `name`」で見る判定関数。 */
describe("isOpenAILLMProviderError", () => {
  it.each(["refusal", "truncated", "no_content", "schema_unsupported"] as const)(
    "本物の例外（kind: %s）を true と判定する",
    (kind) => {
      expect(isOpenAILLMProviderError(new OpenAILLMProviderError({ kind }))).toBe(true);
    },
  );

  it("別のクラス（二重読み込みを模した、kind だけ持つ素のオブジェクト）でも kind で true", () => {
    expect(isOpenAILLMProviderError({ kind: "refusal" })).toBe(true);
  });

  it('kind が無い値は、name が "OpenAILLMProviderError" のときだけ true（古い版が投げた例外）', () => {
    const legacy = new Error("legacy");
    legacy.name = "OpenAILLMProviderError";
    expect(isOpenAILLMProviderError(legacy)).toBe(true);
    expect(isOpenAILLMProviderError(new Error("other"))).toBe(false);
  });

  it("未知の kind は、name が一致していても false", () => {
    expect(isOpenAILLMProviderError({ kind: "unknown_kind", name: "OpenAILLMProviderError" })).toBe(
      false,
    );
  });

  it("エラーでない値・null・undefined は false", () => {
    for (const value of [null, undefined, 0, "refusal", {}, []]) {
      expect(isOpenAILLMProviderError(value)).toBe(false);
    }
  });

  it("他の provider のエラー（別の kind 体系）を取り違えない", () => {
    expect(isOpenAILLMProviderError({ kind: "input_too_long" })).toBe(false);
  });
  it("kind の値が重なる相手の provider の例外（name が違う）を true と判定しない", () => {
    const other = Object.assign(new Error("other"), {
      name: "AnthropicLLMProviderError",
      kind: "refusal",
    });
    expect(isOpenAILLMProviderError(other)).toBe(false);
    // name を持たない素のオブジェクト（二重読み込みを模したもの）は、引き続き kind で見る。
    expect(isOpenAILLMProviderError({ kind: "refusal" })).toBe(true);
  });

  // 相手の name が1つ（"AnthropicLLMProviderError"）だけでなく、どの別の name でも断る
  // （「相手の名前だけ断る」変異を捕まえる）。
  it.each(["LocalEmbeddingProviderError", "Error", "SomethingElse"])(
    "kind を持つが name が %s の値は false",
    (name) => {
      const other = Object.assign(new Error("other"), { name, kind: "refusal" });
      expect(isOpenAILLMProviderError(other)).toBe(false);
    },
  );
});
