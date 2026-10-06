import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import type { Observation } from "../observation.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の #1460 のすり抜け。
 * `observationSpeaker` の `typeof speaker === "string"` を外しても、既存の歯は赤にならなかった
 * （歯が与えていたのは空文字だけで、非文字列を与えていなかった）。
 * 約束（#1460 本文）: speaker が空文字・非文字列なら、候補経路でも何も足さない（本文だけ）。
 */
const TEXT = "明日は東京に出張する予定です";

function observationWithSpeaker(speaker: unknown): Observation {
  return {
    id: "obs-1",
    tenantId: "tenant-1",
    subjectId: "user-1",
    externalId: null,
    kind: "utterance",
    payload: { text: TEXT, speaker },
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    recordedAt: new Date("2026-01-01T00:00:01.000Z"),
  };
}

describe("候補経路で payload.speaker が文字列でないとき、話者の行を足さない（#1460）", () => {
  it.each([
    ["数値", 123],
    ["null", null],
    ["オブジェクト", { name: "田中" }],
    ["配列", ["田中"]],
    ["真偽値", true],
  ])("speaker が%sなら、本文だけが user 入力になる", (_label, speaker) => {
    const prompt = buildExtractionPrompt(observationWithSpeaker(speaker), ["user:a"]);
    expect(prompt.messages).toEqual([{ role: "user", content: TEXT }]);
  });

  it("対照: speaker が空でない文字列なら、話者の行が足される", () => {
    const prompt = buildExtractionPrompt(observationWithSpeaker("田中"), ["user:a"]);
    expect(prompt.messages).toEqual([
      { role: "user", content: `話者（speaker）: 田中\n\n${TEXT}` },
    ]);
  });
});
