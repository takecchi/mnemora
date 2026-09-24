import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { buildMnemoraPrompt } from "../mnemora-path.js";
import { PROVENANCE_PROMPT_CASES } from "./provenance-prompt-cases.js";

/**
 * `buildMnemoraPrompt` の**純粋な描画契約**のテスト（Issue #691）。
 *
 * 🔴 **これは回答評価ではない。** ここでは LLM を一切呼ばない——`RecallResult` を
 * 手で組み立て、`buildMnemoraPrompt`（純関数）に渡し、返ってきた文字列を
 * `provenance-prompt-cases.ts` に固定した期待行と1行ずつ比較するだけである。
 * 「誤帰属・推論の断定を検知する」評価（回答モデルが実際にどう振る舞うか）は、
 * この歯の対象外——それは Issue #498/#693 の回答評価の領分であり、本 PR では
 * 未評価のまま残す（PR 本文参照）。
 *
 * **各ケースは1行ずつ厳密一致（`toBe`）で見る**——部分一致（`toContain`）だと、
 * 「欠落値を "user" 等で埋める」「inferred にも話者を付ける」のような
 * やりすぎた実装が、たまたま期待した部分文字列を含んでいてすり抜ける恐れがある。
 * 厳密一致にしておけば、書式・欄の有無のどんな変異も原則としてここで捕まる。
 */

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
      // 末尾は必ず索引行。digest 行はそれより前に、memories と同じ順で並ぶ。
      const digestLines = lines.slice(0, lines.length - 1);
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
