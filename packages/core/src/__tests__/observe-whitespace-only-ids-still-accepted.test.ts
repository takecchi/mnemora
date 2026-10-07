import { describe, expect, it } from "vitest";
import { ObserveInputSchema } from "../observation.js";

/**
 * Issue #1877（2026-10-06 マージ分の確かめ直し）の #1773 のすり抜け。
 * `Ctx` の TSDoc（#1773 が直した段落）は「`utterance.text`・`event.name`・`document.content` は空白だけも断る
 * （ADR 0502）。**ほかの欄は空白だけの文字列を受け付ける**」と約束する。既存の歯は「断る3欄」と、
 * 「受け付ける」側は `document.title`・`utterance.speaker` の2つだけを縛っていた。`subjectId`・`externalId`・
 * `recallId`・`usedMemoryIds`・`subjectCandidates` の要素を断る側へ広げる変異（`NonBlankTextSchema` の付け間違い）は緑のままだった。
 */
const ok = (input: unknown) => ObserveInputSchema.safeParse(input).success;
const BLANK = "   ";

describe("本文以外の欄は、空白だけの文字列も受け付ける（ADR 0502 の範囲の外）", () => {
  it.each([
    ["utterance.subjectId", { kind: "utterance", text: "t", subjectId: BLANK }],
    ["utterance.externalId", { kind: "utterance", text: "t", externalId: BLANK }],
    ["event.subjectId", { kind: "event", name: "n", subjectId: BLANK }],
    ["event.externalId", { kind: "event", name: "n", externalId: BLANK }],
    ["document.subjectId", { kind: "document", content: "c", subjectId: BLANK }],
    ["document.externalId", { kind: "document", content: "c", externalId: BLANK }],
    [
      "memory_usage.externalId",
      { kind: "memory_usage", recallId: "r", usedMemoryIds: ["m"], externalId: BLANK },
    ],
    ["memory_usage.recallId", { kind: "memory_usage", recallId: BLANK, usedMemoryIds: ["m"] }],
    [
      "memory_usage.usedMemoryIds の要素",
      { kind: "memory_usage", recallId: "r", usedMemoryIds: [BLANK] },
    ],
    [
      "utterance.subjectCandidates の要素",
      { kind: "utterance", text: "t", subjectCandidates: [BLANK] },
    ],
  ])("%s", (_name, input) => {
    expect(ok(input)).toBe(true);
  });

  it("対照: 同じ欄でも、空文字は断る", () => {
    expect(ok({ kind: "utterance", text: "t", subjectId: "" })).toBe(false);
    expect(ok({ kind: "memory_usage", recallId: "", usedMemoryIds: ["m"] })).toBe(false);
  });
});
