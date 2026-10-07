import { describe, expect, it } from "vitest";
import { buildAnswerJson } from "../answer-json.js";

function pathWith(applicable: boolean, preserved: boolean) {
  return {
    promptSpec: { system: "s", messages: [] },
    inputChars: 1,
    inputEstimatedTokens: 1,
    answer: "a",
    verdict: "pass" as const,
    contentPreservation: { applicable, preserved, matchedAcceptTerms: [] as string[] },
  };
}

function resultWith(id: string, naive: [boolean, boolean], mnemora: [boolean, boolean]): never {
  return {
    case: { id, category: "preference", tuningUse: "development" },
    naive: pathWith(...naive),
    mnemora: pathWith(...mnemora),
    cost: {
      extractionLLMCalls: 0,
      embeddingCalls: 0,
      answerLLMCalls: 2,
      judgeLLMCalls: 2,
    },
  } as never;
}

describe("buildAnswerJson: 層2の集計（#699）", () => {
  const results = [
    resultWith("c1", [true, true], [true, true]),
    resultWith("c2", [true, true], [true, false]),
    resultWith("c3", [false, true], [false, true]), // must-abstain: applicable=false
  ];
  const json = buildAnswerJson({
    results,
    llmMode: "recorded",
    embeddingMode: "deterministic",
    measuredAt: new Date("2026-09-24T00:00:00Z"),
    commit: null,
  });

  it("schemaVersion は 3", () => {
    expect(json.schemaVersion).toBe(3);
  });

  it("分母は applicable なケースだけ（must-abstain を除く）で、naive・mnemora それぞれ自分の結果から数える", () => {
    expect(json.contentPreservation.naive).toEqual({ applicable: 2, preserved: 2 });
    expect(json.contentPreservation.mnemora).toEqual({ applicable: 2, preserved: 1 });
  });

  it("ケースごとの欄は、経路ごとの結果をそのまま持つ", () => {
    expect(json.cases[1]!.naive.contentPreservation.preserved).toBe(true);
    expect(json.cases[1]!.mnemora.contentPreservation.preserved).toBe(false);
    expect(json.cases[2]!.mnemora.contentPreservation.applicable).toBe(false);
  });
});
