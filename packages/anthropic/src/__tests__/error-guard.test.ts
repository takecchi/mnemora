import { describe, expect, it } from "vitest";
import { AnthropicLLMProviderError, isAnthropicLLMProviderError } from "../errors.js";

/** ADR 0428 / ADR 0418: `instanceof` を使わず「`kind`、無ければ `name`」で見る判定関数。 */
describe("isAnthropicLLMProviderError", () => {
  it.each(["refusal", "truncated", "no_content", "schema_unsupported"] as const)(
    "本物の例外（kind: %s）を true と判定する",
    (kind) => {
      expect(isAnthropicLLMProviderError(new AnthropicLLMProviderError({ kind }))).toBe(true);
    },
  );

  it("別のクラス（二重読み込みを模した、kind だけ持つ素のオブジェクト）でも kind で true", () => {
    expect(isAnthropicLLMProviderError({ kind: "refusal" })).toBe(true);
  });

  it('kind が無い値は、name が "AnthropicLLMProviderError" のときだけ true（古い版が投げた例外）', () => {
    const legacy = new Error("legacy");
    legacy.name = "AnthropicLLMProviderError";
    expect(isAnthropicLLMProviderError(legacy)).toBe(true);
    expect(isAnthropicLLMProviderError(new Error("other"))).toBe(false);
  });

  it("kind があるなら name は見ない（未知の kind は、name が一致していても false）", () => {
    expect(
      isAnthropicLLMProviderError({ kind: "unknown_kind", name: "AnthropicLLMProviderError" }),
    ).toBe(false);
  });

  it("エラーでない値・null・undefined は false", () => {
    for (const value of [null, undefined, 0, "refusal", {}, []]) {
      expect(isAnthropicLLMProviderError(value)).toBe(false);
    }
  });

  it("他の provider のエラー（別の kind 体系）を取り違えない", () => {
    expect(isAnthropicLLMProviderError({ kind: "input_too_long" })).toBe(false);
  });
});
