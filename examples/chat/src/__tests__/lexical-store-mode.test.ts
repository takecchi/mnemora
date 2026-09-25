import { describe, expect, it } from "vitest";
import { selectLexicalStoreMode } from "../runtime-factory.js";

/**
 * `selectLexicalStoreMode`(Issue #278、ADR 0319)の純関数としての歯。
 * `providers.test.ts` の `selectLLMMode`/`selectEmbeddingMode` の歯と同じ形——
 * DB を要さない、`MNEMORA_LEXICAL_STORE` の解釈だけを検査する。
 */
describe("selectLexicalStoreMode", () => {
  it("未指定なら既定値 'default' を返す（既定を変えない）", () => {
    expect(selectLexicalStoreMode({})).toBe("default");
  });

  it("空文字は未指定として扱う（parseModeOverride と同じ作法）", () => {
    expect(selectLexicalStoreMode({ MNEMORA_LEXICAL_STORE: "" })).toBe("default");
  });

  it("'default' を明示すればそのまま返す", () => {
    expect(selectLexicalStoreMode({ MNEMORA_LEXICAL_STORE: "default" })).toBe("default");
  });

  it("'trigram' を指定すればそのまま返す(opt-in)", () => {
    expect(selectLexicalStoreMode({ MNEMORA_LEXICAL_STORE: "trigram" })).toBe("trigram");
  });

  it("未知の値は例外(既存の parseModeOverride と同じ作法)", () => {
    expect(() => selectLexicalStoreMode({ MNEMORA_LEXICAL_STORE: "pgroonga" })).toThrow(
      /MNEMORA_LEXICAL_STORE/,
    );
  });
});
