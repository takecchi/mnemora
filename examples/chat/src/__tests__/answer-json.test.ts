import { describe, expect, it } from "vitest";
import { buildAnswerJson } from "../answer-json.js";

/**
 * `buildAnswerJson`（`answer` の実行結果 JSON）の層2（内容保持、#693 / ADR 0296）の集計。
 * DB 不要。`answer-bench.postgres.test.ts`・`answer-cli.postgres.test.ts` は `preserved === true`
 * しか固定しておらず、分母・経路の取り違え・`schemaVersion` を見る歯が無かった
 * （Issue #1776 の #699 のコメント、ADR 0665）。
 */

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
  // naive は3件とも保持。mnemora は closed-value の2件のうち1件が欠落。3件目は must-abstain。
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
