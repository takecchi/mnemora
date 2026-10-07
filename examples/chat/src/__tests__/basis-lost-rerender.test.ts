import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { buildMnemoraPrompt } from "../mnemora-path.js";
import { parseMnemoraPromptBody } from "../answer-trials-material.js";
import type { CaseMaterial } from "../answer-trials-material.js";
import { digestOnlyRenderer, orderLegendRenderer } from "../answer-trials-render.js";

const SCORE = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };

function recallWith(memories: RecallResult["memories"]): RecallResult {
  return {
    recallId: "recall-basis-lost-rerender",
    memories,
    omitted: [],
    index: { groups: [], totalInScope: memories.length, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

const question = "好きな色は?";
const body = buildMnemoraPrompt(
  recallWith([
    {
      memoryId: "m-1",
      digest: "青系を好むと推測される",
      retrievedVia: "ann",
      provenanceKind: "inferred",
      basisLost: true,
      speaker: null,
      subjectId: "user-1",
      recordedAt: new Date("2026-09-01T00:00:00Z"),
      occurredAt: null,
      score: SCORE,
    },
  ]),
);
const material = {
  caseId: "basis-lost-rerender",
  question,
  system: "",
  ...parseMnemoraPromptBody(body),
  rawContent: `${body}\n\n質問: ${question}`,
} as CaseMaterial;

// 根拠の欄は、パーサが basisLost として読み取った後、描き直しごとに出すか出さないかが決まる。
describe("根拠を失った行の描き直し", () => {
  it("digest-only は digest だけを出し、根拠の欄を漏らさない", () => {
    const text = digestOnlyRenderer.renderUserContent(material);
    expect(text).toContain("青系を好むと推測される");
    expect(text).not.toContain("根拠");
  });

  it("order-legend は根拠の欄を、主題の後・記録順の前に出す", () => {
    const text = orderLegendRenderer.renderUserContent(material);
    expect(text).toMatch(/\[主題:user-1\] \[根拠:失われた\] \[記録順:1\] .*青系を好むと推測される/);
  });
});
