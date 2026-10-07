import type { AnswerExpectation } from "./answer-case.js";
import { normalizeForGrading } from "./answer-case.js";

/**
 * 層2（回答に必要な情報の保持）の決定的な指標。LLM も DB も呼ばない純関数。
 *
 * 部分文字列一致なので、`expected.accept` に無い言い換えで情報が残っていても `preserved: false` になる
 * （偽陰性がありうる）。`expected.reject` は見ない。紛らわしい情報が混ざるかは層3の役目。
 * naive 経路で `false` が出たら、ケースの authoring を疑うこと。
 */
export interface ContentPreservationResult {
  applicable: boolean;
  preserved: boolean;
  matchedAcceptTerms: string[];
}

/** `digest` 単体ではなく、モデルへ実際に渡す文字列全体を受け取ること。 */
export function checkContentPreserved(
  serializedPrompt: string,
  expected: AnswerExpectation,
): ContentPreservationResult {
  if (expected.kind === "must-abstain") {
    return { applicable: false, preserved: true, matchedAcceptTerms: [] };
  }
  const normalizedPrompt = normalizeForGrading(serializedPrompt);
  const matchedAcceptTerms = expected.accept.filter((term) =>
    normalizedPrompt.includes(normalizeForGrading(term)),
  );
  return {
    applicable: true,
    preserved: matchedAcceptTerms.length > 0,
    matchedAcceptTerms,
  };
}
