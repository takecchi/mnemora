import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { ORDER_LEGEND_LINE, buildMnemoraPrompt } from "../mnemora-path.js";
import { PROVENANCE_PROMPT_CASES } from "./provenance-prompt-cases.js";

// 各ケースは toContain ではなく toBe で見る。部分一致だと「欠落値を user で埋める」ような過剰な実装がすり抜ける。

function recallWith(memories: RecallResult["memories"]): RecallResult {
  return {
    recallId: "recall-provenance-prompt-contract",
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

describe("buildMnemoraPrompt: 由来・話者・主題・矛盾関係の描画契約（Issue #691）", () => {
  for (const c of PROVENANCE_PROMPT_CASES) {
    it(`${c.id}: ${c.description}`, () => {
      const prompt = buildMnemoraPrompt(recallWith(c.memories));
      const lines = prompt.split("\n");
      const hasLegend = lines[0] === ORDER_LEGEND_LINE;
      expect(hasLegend).toBe(c.expectedLegend ?? false);
      const digestLines = lines.slice(hasLegend ? 1 : 0, lines.length - 1);
      expect(digestLines).toEqual(c.expectedLines);
    });
  }

  it("全ケースの索引行は「スコープ内 N 件のうち N 件を提示」のまま変わらない", () => {
    for (const c of PROVENANCE_PROMPT_CASES) {
      const prompt = buildMnemoraPrompt(recallWith(c.memories));
      const n = c.memories.length;
      expect(prompt).toContain(`(索引: スコープ内 ${n} 件のうち ${n} 件を提示)`);
    }
  });
});

describe("buildMnemoraPrompt: 矛盾候補の印は、同伴取得（mandatory_companion）された側にだけ付く（#698）", () => {
  const SCORE = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };
  const common = {
    provenanceKind: "stated" as const,
    speaker: "太郎",
    subjectId: "user-1",
    recordedAt: new Date("2026-09-01T00:00:00Z"),
    occurredAt: null,
    score: SCORE,
  };

  it("companionOf を持つが retrievedVia が ann の行は、その行に矛盾候補の印が出ない", () => {
    const prompt = buildMnemoraPrompt(
      recallWith([
        { ...common, memoryId: "m-a", digest: "行A", retrievedVia: "ann", companionOf: "m-b" },
        { ...common, memoryId: "m-b", digest: "行B", retrievedVia: "ann" },
      ]),
    );
    const lineA = prompt.split("\n").find((l) => l.includes("行A"))!;
    expect(lineA).not.toContain("[矛盾候補");
  });

  it("対照: 同じ組を retrievedVia: mandatory_companion にすると、その行に印が出る", () => {
    const prompt = buildMnemoraPrompt(
      recallWith([
        {
          ...common,
          memoryId: "m-a",
          digest: "行A",
          retrievedVia: "mandatory_companion",
          companionOf: "m-b",
        },
        { ...common, memoryId: "m-b", digest: "行B", retrievedVia: "ann" },
      ]),
    );
    const lineA = prompt.split("\n").find((l) => l.includes("行A"))!;
    expect(lineA).toContain("[矛盾候補");
  });
});
