import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import {
  ANSWER_SYSTEM_PROMPT,
  CONTESTED_CORRECTION_GUIDANCE,
  resolveMnemoraAnswerSystemPrompt,
} from "../answer-bench.js";
import { buildMnemoraPrompt, promptHasContestedCorrectionMarker } from "../mnemora-path.js";
import { PROVENANCE_PROMPT_CASES } from "./provenance-prompt-cases.js";

/**
 * Issue #1430（ADR 0379）の歯。
 *
 * 1. `promptHasContestedCorrectionMarker`: 案1（非対称文面）が実際に出たプロンプトと
 *    出ていないプロンプトを正しく判別できること。
 * 2. `resolveMnemoraAnswerSystemPrompt`: 案3（system 文への一文追記、切替可能）が
 *    「opt-in のフラグ」ではなく「実際に印が出たか」で on/off を決めること
 *    （フラグ true でも印が無ければ足さない・フラグ false なら印があっても足さない）。
 *
 * どちらも DB・API を一切使わない純関数の単体試験である。
 */

function recallWith(memories: RecallResult["memories"]): RecallResult {
  return {
    recallId: "recall-issue-1430",
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

function caseById(id: string) {
  const found = PROVENANCE_PROMPT_CASES.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`provenance-prompt-cases.ts に "${id}" が見つからない。`);
  }
  return found;
}

describe("promptHasContestedCorrectionMarker", () => {
  it("案1の非対称文面（新しい側）を含むプロンプトは true", () => {
    const c = caseById("contested-with-asymmetric-both-recorded");
    const prompt = buildMnemoraPrompt(recallWith(c.memories));
    expect(prompt).toContain("より後の記録（訂正の可能性）");
    expect(promptHasContestedCorrectionMarker(prompt)).toBe(true);
  });

  it("companionOf 由来 + 記録順ありでも、対称な旧文面のままなら false", () => {
    const c = caseById("contested-with-companion-order-known-but-old-wording");
    const prompt = buildMnemoraPrompt(recallWith(c.memories));
    expect(prompt).not.toContain("訂正");
    expect(promptHasContestedCorrectionMarker(prompt)).toBe(false);
  });

  it("記録順が片方でも分からない contestedWith 対は、旧文面のままなので false", () => {
    const c = caseById("contested-with-order-known-only-one-side");
    const prompt = buildMnemoraPrompt(recallWith(c.memories));
    expect(promptHasContestedCorrectionMarker(prompt)).toBe(false);
  });

  it("矛盾候補欄そのものが無いプロンプトは false", () => {
    const c = caseById("stated-with-speaker");
    const prompt = buildMnemoraPrompt(recallWith(c.memories));
    expect(promptHasContestedCorrectionMarker(prompt)).toBe(false);
  });

  it("空文字列は false", () => {
    expect(promptHasContestedCorrectionMarker("")).toBe(false);
  });
});

describe("resolveMnemoraAnswerSystemPrompt（案3、切替可能）", () => {
  const withMarker = "本文中に（訂正の可能性）が含まれる行";
  const withoutMarker = "矛盾候補の印を含まない普通の本文";

  it("フラグ true + 印が出た本文 → ANSWER_SYSTEM_PROMPT + CONTESTED_CORRECTION_GUIDANCE", () => {
    expect(resolveMnemoraAnswerSystemPrompt(withMarker, true)).toBe(
      `${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`,
    );
  });

  it("フラグ true + 印が出ない本文 → ANSWER_SYSTEM_PROMPT のまま（印の有無で決める。opt-in だけでは足さない）", () => {
    expect(resolveMnemoraAnswerSystemPrompt(withoutMarker, true)).toBe(ANSWER_SYSTEM_PROMPT);
  });

  it("フラグ false + 印が出た本文 → ANSWER_SYSTEM_PROMPT のまま（フラグが off なら足さない）", () => {
    expect(resolveMnemoraAnswerSystemPrompt(withMarker, false)).toBe(ANSWER_SYSTEM_PROMPT);
  });

  it("フラグ false + 印が出ない本文 → ANSWER_SYSTEM_PROMPT のまま", () => {
    expect(resolveMnemoraAnswerSystemPrompt(withoutMarker, false)).toBe(ANSWER_SYSTEM_PROMPT);
  });

  it("区切りに空白を挟まず、句点の直後にそのまま連結する", () => {
    const combined = resolveMnemoraAnswerSystemPrompt(withMarker, true);
    expect(combined).toBe(
      "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。" +
        "矛盾候補の印がある記憶どうしは、記録順の新しい方を現在の値として答えてください。",
    );
  });
});
