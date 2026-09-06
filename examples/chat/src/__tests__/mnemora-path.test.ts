import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { buildMnemoraPrompt } from "../mnemora-path.js";

function recallWith(memories: RecallResult["memories"]): RecallResult {
  return {
    recallId: "recall-1",
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

describe("buildMnemoraPrompt", () => {
  it("memories が0件なら index の行だけになる（空の digest 行は filter で落ちる）", () => {
    const prompt = buildMnemoraPrompt(recallWith([]));
    // 空の digest 行を落とさずに join すると先頭に無駄な改行が付く。
    // ここでは「index の行そのものと完全に一致する」ことまで確認する。
    expect(prompt).toBe("(索引: スコープ内 0 件のうち 0 件を提示)");
  });

  it("memories がある場合は digest を箇条書きにし、index 行も出す", () => {
    const prompt = buildMnemoraPrompt(
      recallWith([
        {
          memoryId: "m1",
          digest: "テストの digest",
          retrievedVia: "ann",
          provenanceKind: "stated",
          score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
        },
      ]),
    );
    expect(prompt).toContain("- テストの digest");
    expect(prompt).toContain("1 件のうち 1 件");
  });
});
