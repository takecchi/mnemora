import { describe, expect, it } from "vitest";
import { resolveAnswerClaimKeyOptions } from "../answer-claim-key-options.js";

/**
 * `resolveAnswerClaimKeyOptions`（Issue #691 続き）の単体テスト。
 *
 * `providers.ts` の `parseModeOverride`（`MNEMORA_LLM`/`MNEMORA_EMBEDDING`）と同じ作法
 * ——未設定/空文字は「未指定」、未知の値は例外——をこの新しい env にも当てる。
 */
describe("resolveAnswerClaimKeyOptions", () => {
  it("MNEMORA_ANSWER_CLAIM_KEY が未設定なら undefined", () => {
    expect(resolveAnswerClaimKeyOptions({})).toBeUndefined();
  });

  it("MNEMORA_ANSWER_CLAIM_KEY が空文字なら undefined(未指定と同じ扱い)", () => {
    expect(resolveAnswerClaimKeyOptions({ MNEMORA_ANSWER_CLAIM_KEY: "" })).toBeUndefined();
  });

  it('MNEMORA_ANSWER_CLAIM_KEY="detect" なら enabled/detectContested が true、knownPredicates は渡さない', () => {
    const result = resolveAnswerClaimKeyOptions({ MNEMORA_ANSWER_CLAIM_KEY: "detect" });
    expect(result).toEqual({ enabled: true, detectContested: true });
    expect(result && "knownPredicates" in result).toBe(false);
  });

  it('MNEMORA_ANSWER_CLAIM_KEY="detect-known-predicates-from-store" なら knownPredicatesFromStore が true になる（Issue #691続き、ADR 0328）', () => {
    const result = resolveAnswerClaimKeyOptions({
      MNEMORA_ANSWER_CLAIM_KEY: "detect-known-predicates-from-store",
    });
    expect(result).toEqual({
      enabled: true,
      detectContested: true,
      knownPredicatesFromStore: true,
    });
    expect(result && "knownPredicates" in result).toBe(false);
  });

  it("未知の値は例外(黙って既定へ倒れない)", () => {
    expect(() => resolveAnswerClaimKeyOptions({ MNEMORA_ANSWER_CLAIM_KEY: "on" })).toThrow(
      /MNEMORA_ANSWER_CLAIM_KEY/,
    );
  });
});
