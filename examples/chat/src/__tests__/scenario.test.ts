import { describe, expect, it } from "vitest";
import { FACT_STATEMENT, QUERY_TEXT, buildConversation } from "../scenario.js";

describe("buildConversation", () => {
  it("fillerPairs=0 なら事実表明の往復1組だけになる", () => {
    const conversation = buildConversation(0);
    expect(conversation.turns).toHaveLength(2);
    expect(conversation.turns[0]).toMatchObject({ role: "user", text: FACT_STATEMENT });
    expect(conversation.userUtterances).toHaveLength(1);
    expect(conversation.query).toBe(QUERY_TEXT);
  });

  it("fillerPairs=N なら往復 (1+N) 組、user 発話は (1+N) 件になる", () => {
    const conversation = buildConversation(5);
    expect(conversation.turns).toHaveLength(2 * (1 + 5));
    expect(conversation.userUtterances).toHaveLength(1 + 5);
  });

  it("filler の行は話題×述語の直積で機械的に決まる（同じ会話を2回作れば同じ文字列になる=決定的）", () => {
    const a = buildConversation(20);
    const b = buildConversation(20);
    expect(a.turns.map((t) => t.text)).toEqual(b.turns.map((t) => t.text));
  });

  /**
   * Issue #340: 以前は filler の user 発話が12文を `i % 12` で巡回していたため、
   * `fillerPairs=160`（`turnCount=322`）のような長い会話で同じ文が約13回重複し、
   * 連想枠の tie-break を非決定にした（ADR 0170 §3）。ここでは
   * `DEFAULT_COMPARE_SEQUENCE`（`compare.ts`）の最大 `fillerPairs=320` 分、
   * user・assistant それぞれの filler がすべて相異なることを機械的に固定する。
   */
  it("filler の user 発話は fillerPairs=320 まですべて相異なる（Issue #340）", () => {
    const conversation = buildConversation(320);
    const fillerUserTexts = conversation.userUtterances.slice(1).map((t) => t.text);
    expect(fillerUserTexts).toHaveLength(320);
    expect(new Set(fillerUserTexts).size).toBe(320);
  });

  it("filler の assistant 発話も fillerPairs=320 まですべて相異なる（Issue #340）", () => {
    const conversation = buildConversation(320);
    const fillerAssistantTexts = conversation.turns
      .filter((t) => t.role === "assistant")
      .slice(1)
      .map((t) => t.text);
    expect(fillerAssistantTexts).toHaveLength(320);
    expect(new Set(fillerAssistantTexts).size).toBe(320);
  });

  it("filler の user 発話は FACT_STATEMENT / QUERY_TEXT のいずれとも衝突しない", () => {
    const conversation = buildConversation(320);
    const fillerUserTexts = new Set(conversation.userUtterances.slice(1).map((t) => t.text));
    expect(fillerUserTexts.has(FACT_STATEMENT)).toBe(false);
    expect(fillerUserTexts.has(QUERY_TEXT)).toBe(false);
  });

  it("turn の index は 0 始まりの連番", () => {
    const conversation = buildConversation(3);
    conversation.turns.forEach((turn, i) => {
      expect(turn.index).toBe(i);
    });
  });

  it("fillerPairs が負・非整数なら例外を投げる", () => {
    expect(() => buildConversation(-1)).toThrow(/0 以上の整数/);
    expect(() => buildConversation(1.5)).toThrow(/0 以上の整数/);
  });
});
