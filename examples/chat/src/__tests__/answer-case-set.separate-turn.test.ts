import { describe, expect, it } from "vitest";
import { assertGroundsPresent, normalizeForGrading } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { ANSWER_CASE_SET_SEPARATE_TURN } from "../answer-case-set.separate-turn.js";

describe("answer-case-set.separate-turn.ts", () => {
  it("3〜6件である", () => {
    expect(ANSWER_CASE_SET_SEPARATE_TURN.length).toBeGreaterThanOrEqual(3);
    expect(ANSWER_CASE_SET_SEPARATE_TURN.length).toBeLessThanOrEqual(6);
  });

  it("全件 tuningUse === held-out", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      expect(c.tuningUse).toBe("held-out");
    }
  });

  it("全件 6〜12ターン", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      expect(c.conversation.length).toBeGreaterThanOrEqual(6);
      expect(c.conversation.length).toBeLessThanOrEqual(12);
    }
  });

  it("全件 assertGroundsPresent を通る", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      expect(() => assertGroundsPresent(c)).not.toThrow();
    }
  });

  it("id が重複しない", () => {
    const ids = ANSWER_CASE_SET_SEPARATE_TURN.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("既存14件（dev6+eval8）の id と重複しない——別の集合であることを機械的に確認する", () => {
    const existingIds = new Set([...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL].map((c) => c.id));
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      expect(existingIds.has(c.id)).toBe(false);
    }
  });

  it("closed-value は accept が非空", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      expect(c.expected.kind).toBe("closed-value");
      expect(c.expected.accept.length).toBeGreaterThan(0);
    }
  });

  it("全件 knownSubjects を ['user', <第三者>] の形で持つ", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      expect(c.knownSubjects).toBeDefined();
      expect(c.knownSubjects?.[0]).toBe("user");
      expect(c.knownSubjects?.length).toBe(2);
      expect(c.knownSubjects?.[1]).not.toBe("user");
    }
  });

  it("expected.accept の語と expected.reject の語が同じターンに同居しない（別ターンであることの構造的な歯）", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      const acceptWords = c.expected.accept.map((w) => normalizeForGrading(w));
      const rejectWords = c.expected.reject.map((w) => normalizeForGrading(w));
      for (const turn of c.conversation) {
        const normalizedText = normalizeForGrading(turn.text);
        const hasAccept = acceptWords.some((w) => w.length > 0 && normalizedText.includes(w));
        const hasReject = rejectWords.some((w) => w.length > 0 && normalizedText.includes(w));
        expect(
          hasAccept && hasReject,
          `case "${c.id}" のターン "${turn.text}" に accept 語と reject 語が同居している`,
        ).toBe(false);
      }
    }
  });

  // 語順ストレス（eval-misattribution-order-swapped 型）は対象外。別ターンという条件だけを切り分ける。
  it("本人の事実のターンが、第三者の事実のターン（grounds.turnIndex）より前にある", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      const rejectWords = c.expected.reject.map((w) => normalizeForGrading(w));
      const thirdPartyTurnIndex = c.grounds.turnIndex[0];
      expect(thirdPartyTurnIndex).toBeDefined();
      const ownFactTurnIndex = c.conversation.findIndex((turn) => {
        const normalizedText = normalizeForGrading(turn.text);
        return rejectWords.some((w) => w.length > 0 && normalizedText.includes(w));
      });
      expect(ownFactTurnIndex).toBeGreaterThanOrEqual(0);
      expect(ownFactTurnIndex).toBeLessThan(thirdPartyTurnIndex as number);
    }
  });
});
