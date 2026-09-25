import { describe, expect, it } from "vitest";
import { assertGroundsPresent, normalizeForGrading } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { ANSWER_CASE_SET_SEPARATE_TURN } from "../answer-case-set.separate-turn.js";

/**
 * `answer-case-set.separate-turn.ts`（ADR 0334 追記 2026-09-26（2）、クローン miku の
 * 委譲で動くセッションが追加）の構造検査。
 *
 * ⛔ **既存の `answer-case-set.dev.ts`/`answer-case-set.eval.ts`（14件）はここでは
 * 一切変更しない**——この試験は新しいファイルだけを対象にする。「14件中4件」の歯
 * （`answer-case.test.ts`）は変えていないことを、下の「既存14件との id 非重複」でも
 * 間接的に確認する。
 */
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

  /**
   * ADR 0334 決定1「型A」の前提（本人の事実と第三者の事実が別々の `observe()` 呼び出し
   * にある）を機械的に固定する歯。**全件 `knownSubjects` を持つ**（`["user", 他1名]`）
   * ——この集合の存在意義そのもの。
   */
  it("全件 knownSubjects を ['user', <第三者>] の形で持つ", () => {
    for (const c of ANSWER_CASE_SET_SEPARATE_TURN) {
      expect(c.knownSubjects).toBeDefined();
      expect(c.knownSubjects?.[0]).toBe("user");
      expect(c.knownSubjects?.length).toBe(2);
      expect(c.knownSubjects?.[1]).not.toBe("user");
    }
  });

  /**
   * 「別ターン」であることの機械的な歯: 本人の事実の語（`expected.reject`）と
   * 第三者の事実の語（`expected.accept`）が、同じ `conversation` ターンの本文に
   * 同居してはならない。既存14件のうち `knownSubjects` を持つ4件
   * （`other-person-birthday` 等）はこれが同居していた（1ターンに両者の値が
   * 並んでいた）——本テストはその構成をこの新しい集合では取らないことを固定する。
   *
   * 同居していれば、`deriveClaimKeys` が1回のバッチで両方の値を比較材料として
   * 受け取れてしまい、ADR 0334 決定1「型A」の前提（比較材料を構造的に持たない）が
   * 崩れる——だから、この歯が通ることは「型Aの前提を壊していない」ことの構造的な
   * 裏付けになる（実際に別 `observe()` 呼び出しになるかどうかは
   * `mnemora-path.ts` の `ingestConversation` の実装——1ユーザーターン=1
   * `observe()`——に依存する。ここではケース定義側の構造だけを固定する）。
   */
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

  /**
   * `grounds.turnIndex` が指す第三者の事実のターンより前に、本人の事実（reject 語を
   * 含むターン）が存在する——2つの事実が別々のターンとして、かつ本人が先に発話した
   * 順序で並んでいることを固定する（既存4件と同じ語順、`eval-misattribution-
   * order-swapped` のような語順ストレスはこの集合の対象外——別ターンという条件だけを
   * 切り分けたいため）。
   */
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
