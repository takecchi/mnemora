import { describe, expect, it } from "vitest";
import type { ClaimKeyOptions } from "@mnemora/core";
import {
  applyCaseKnownSubjects,
  resolveAnswerClaimKeyOptions,
} from "../answer-claim-key-options.js";

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

  it('MNEMORA_ANSWER_CLAIM_KEY="detect-known-predicates-from-store" なら knownPredicatesFromStore が true になる（Issue #691続き、ADR 0329）', () => {
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

/**
 * `applyCaseKnownSubjects`（ADR 0334 負債2、Issue #372負債6の続き）の単体テスト。
 *
 * **省けば従来どおり**——`condition !== "known-subjects"`、またはケースが
 * `knownSubjects` を持たない場合は、渡された `claimKeyOptions` をそのまま
 * （同じ参照で）返すことを固定する。**指定すれば渡る**——`condition ===
 * "known-subjects"` かつケースが `knownSubjects` を持つときだけ合流することを固定する。
 */
describe("applyCaseKnownSubjects", () => {
  const baseline: ClaimKeyOptions = { enabled: true, detectContested: true };

  it('condition が "known-subjects" 以外なら、caseKnownSubjects が在っても素通し（同じ参照）', () => {
    const result = applyCaseKnownSubjects(baseline, "baseline", ["user", "妻"]);
    expect(result).toBe(baseline);
  });

  it('condition が "known-predicates-from-store" でも、caseKnownSubjects が在っても素通し（同じ参照）', () => {
    const withStore: ClaimKeyOptions = {
      enabled: true,
      detectContested: true,
      knownPredicatesFromStore: true,
    };
    const result = applyCaseKnownSubjects(withStore, "known-predicates-from-store", ["user", "妻"]);
    expect(result).toBe(withStore);
  });

  it('condition が "known-subjects" でも、ケースが knownSubjects を持たなければ素通し（同じ参照）', () => {
    const result = applyCaseKnownSubjects(baseline, "known-subjects", undefined);
    expect(result).toBe(baseline);
  });

  it('condition が "known-subjects" かつケースが knownSubjects を持てば合流する', () => {
    const result = applyCaseKnownSubjects(baseline, "known-subjects", ["user", "妻"]);
    expect(result).toEqual({ enabled: true, detectContested: true, knownSubjects: ["user", "妻"] });
    // 元のオブジェクトは変更しない。
    expect(baseline).toEqual({ enabled: true, detectContested: true });
    expect("knownSubjects" in baseline).toBe(false);
  });

  it("knownPredicatesFromStore と knownSubjects は共存できる（合流は knownSubjects だけを足す）", () => {
    const withStore: ClaimKeyOptions = {
      enabled: true,
      detectContested: true,
      knownPredicatesFromStore: true,
    };
    const result = applyCaseKnownSubjects(withStore, "known-subjects", ["user", "息子"]);
    expect(result).toEqual({
      enabled: true,
      detectContested: true,
      knownPredicatesFromStore: true,
      knownSubjects: ["user", "息子"],
    });
  });
});
