import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { buildMnemoraPrompt } from "../mnemora-path.js";
import { parseMemoryLine, parseMnemoraPromptBody } from "../answer-trials-material.js";
import type { CaseMaterial } from "../answer-trials-material.js";
import { recordedRenderer } from "../answer-trials-render.js";

const SCORE = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };

function recallWith(memories: RecallResult["memories"]): RecallResult {
  return {
    recallId: "recall-basis-lost-roundtrip",
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

describe("[根拠:失われた] の欄（Issue #972）", () => {
  it("parseMemoryLine は欄を basisLost として読み、digest に混ぜない", () => {
    const parsed = parseMemoryLine(
      "- [由来:inferred] [主題:user-1] [矛盾候補:「相手」] [根拠:失われた] [記録順:2] 推論された主張",
    );
    expect(parsed.basisLost).toBe(true);
    expect(parsed.contradiction).toBe("「相手」");
    expect(parsed.recordedOrder).toBe(2);
    expect(parsed.digest).toBe("推論された主張");
  });

  it("欄が無い行では basisLost を持たない", () => {
    expect(parseMemoryLine("- [由来:inferred] [主題:user-1] 推論").basisLost).toBeUndefined();
  });

  it("根拠欄の値が「失われた」以外なら例外（黙って飲み込まない）", () => {
    expect(() => parseMemoryLine("- [由来:inferred] [主題:user-1] [根拠:あり] 推論")).toThrow();
  });

  it("buildMnemoraPrompt の出力 → パース → recordedRenderer の再構成が原文と一致する", () => {
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
        {
          memoryId: "m-2",
          digest: "青が好き",
          retrievedVia: "ann",
          provenanceKind: "stated",
          speaker: "太郎",
          subjectId: "user-1",
          recordedAt: new Date("2026-09-02T00:00:00Z"),
          occurredAt: null,
          score: SCORE,
        },
      ]),
    );
    expect(body).toContain("[根拠:失われた]");
    const question = "好きな色は?";
    const parsed = parseMnemoraPromptBody(body);
    const material: CaseMaterial = {
      caseId: "basis-lost-roundtrip",
      question,
      system: "",
      ...parsed,
      rawContent: `${body}\n\n質問: ${question}`,
    } as CaseMaterial;
    expect(() => recordedRenderer.renderUserContent(material)).not.toThrow();
    expect(parsed.lines.map((l) => l.digest)).not.toContainEqual(expect.stringContaining("[根拠"));
  });
});

describe("[根拠:失われた] は basisLost が true のときだけ出る（#698）", () => {
  const base = {
    memoryId: "m-1",
    digest: "青系を好むと推測される",
    retrievedVia: "ann" as const,
    provenanceKind: "inferred" as const,
    speaker: null,
    subjectId: "user-1",
    recordedAt: new Date("2026-09-01T00:00:00Z"),
    occurredAt: null,
    score: SCORE,
  };

  it("basisLost: false の inferred の行には出ない", () => {
    const body = buildMnemoraPrompt(recallWith([{ ...base, basisLost: false as never }]));
    expect(body).not.toContain("[根拠");
  });

  it("basisLost を持たない行にも出ない（対照: true の行にだけ出る）", () => {
    expect(buildMnemoraPrompt(recallWith([{ ...base }]))).not.toContain("[根拠");
    expect(buildMnemoraPrompt(recallWith([{ ...base, basisLost: true }]))).toContain(
      "[根拠:失われた]",
    );
  });
});
