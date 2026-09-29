import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import {
  ANSWER_SYSTEM_PROMPT,
  CONTESTED_CORRECTION_GUIDANCE,
  resolveMnemoraAnswerSystemPrompt,
} from "../answer-bench.js";
import { buildMnemoraPrompt, buildMnemoraPromptDetail } from "../mnemora-path.js";
import { PROVENANCE_PROMPT_CASES } from "./provenance-prompt-cases.js";

/**
 * Issue #1430（ADR 0379、C2 採用: 案1＋案3、案3は既定オン）の歯。
 *
 * 1. `buildMnemoraPromptDetail`: `hasContestedCorrectionWording` は、描画の途中
 *    （矛盾候補欄が非対称文面＝案1を選ぶ分岐そのもの）から決まる**構造の値**であり、
 *    できあがった `body`（プロンプト文字列）を後から部分文字列で走査し直すものではない。
 *    `digest` の本文にたまたま「（訂正の可能性）」/「（訂正された可能性）」という文字列が
 *    紛れ込んでいても、それだけでは `true` にならないことを固定する。
 * 2. `buildMnemoraPrompt(recall)` は `buildMnemoraPromptDetail(recall).body` と1バイトも
 *    変わらない（公開シグネチャ・出力を変えていない後方互換ラッパー）ことを固定する。
 * 3. `resolveMnemoraAnswerSystemPrompt`: 案3（system 文への一文追記、既定オン・
 *    切替可能）が、`hasContestedCorrectionWording` が `true` のときだけ一文を足すこと
 *    （フラグが既定 `true` でも、印が無ければ足さない）。
 *
 * どちらも DB・API を一切使わない純関数の単体試験である。
 */

const SCORE = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };

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

describe("buildMnemoraPromptDetail: hasContestedCorrectionWording（構造で見る判定）", () => {
  it("非対称文面（新しい側）が出た回は true", () => {
    const c = caseById("contested-with-asymmetric-both-recorded");
    const detail = buildMnemoraPromptDetail(recallWith(c.memories));
    expect(detail.body).toContain("より後の記録（訂正の可能性）");
    expect(detail.hasContestedCorrectionWording).toBe(true);
  });

  it("companionOf 由来 + 記録順ありでも、対称な旧文面のままなら false", () => {
    const c = caseById("contested-with-companion-order-known-but-old-wording");
    const detail = buildMnemoraPromptDetail(recallWith(c.memories));
    expect(detail.body).not.toContain("訂正");
    expect(detail.hasContestedCorrectionWording).toBe(false);
  });

  it("記録順が片方でも分からない contestedWith 対（対称の文面のまま）は false", () => {
    const c = caseById("contested-with-order-known-only-one-side");
    const detail = buildMnemoraPromptDetail(recallWith(c.memories));
    expect(detail.hasContestedCorrectionWording).toBe(false);
  });

  it("矛盾候補欄そのものが無い recall（印なし）は false", () => {
    const c = caseById("stated-with-speaker");
    const detail = buildMnemoraPromptDetail(recallWith(c.memories));
    expect(detail.hasContestedCorrectionWording).toBe(false);
  });

  it("記憶が0件でも false", () => {
    const detail = buildMnemoraPromptDetail(recallWith([]));
    expect(detail.hasContestedCorrectionWording).toBe(false);
  });

  it(
    "🔴 digest の本文にたまたま「（訂正の可能性）」が紛れ込んでいても、矛盾関係が無ければ" +
      " false のまま（部分文字列の判定には戻らないことの歯）",
    () => {
      const decoy: RecallResult["memories"][number] = {
        memoryId: "m-decoy-no-relation",
        digest: "会議は10時から（訂正の可能性）もあると言っていた",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      };
      const detail = buildMnemoraPromptDetail(recallWith([decoy]));
      // 文字列としては body に紛れ込んでいることを先に確認する
      // （でなければ、この歯が「そもそも紛れ込んでいない」だけで通ってしまう）。
      expect(detail.body).toContain("（訂正の可能性）");
      expect(detail.hasContestedCorrectionWording).toBe(false);
    },
  );

  it(
    "🔴 digest にたまたま「（訂正された可能性）」が紛れ込み、かつ companionOf 由来の" +
      "（対称な）矛盾候補欄と共存していても false のまま",
    () => {
      const owner: RecallResult["memories"][number] = {
        memoryId: "m-decoy-owner",
        digest: "休みは月曜（訂正された可能性）もある",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      };
      const companion: RecallResult["memories"][number] = {
        memoryId: "m-decoy-companion",
        digest: "休みは火曜",
        retrievedVia: "mandatory_companion",
        companionOf: "m-decoy-owner",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-1",
        score: SCORE,
      };
      const detail = buildMnemoraPromptDetail(recallWith([owner, companion]));
      expect(detail.body).toContain("（訂正された可能性）");
      // companionOf 由来なので対称な旧文面（矛盾候補欄そのものは出る）。
      expect(detail.body).toContain("[矛盾候補:");
      expect(detail.hasContestedCorrectionWording).toBe(false);
    },
  );

  it("buildMnemoraPrompt(recall) は buildMnemoraPromptDetail(recall).body と1バイトも変わらない（後方互換ラッパー）", () => {
    const c = caseById("contested-with-asymmetric-both-recorded");
    const recall = recallWith(c.memories);
    expect(buildMnemoraPrompt(recall)).toBe(buildMnemoraPromptDetail(recall).body);
  });
});

describe("resolveMnemoraAnswerSystemPrompt（案3、既定オン・切替可能。ADR 0379 決定「C2 採用」）", () => {
  it("hasContestedCorrectionWording=true・フラグ true（既定） → 一文を足す", () => {
    expect(resolveMnemoraAnswerSystemPrompt(true, true)).toBe(
      `${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`,
    );
  });

  it(
    "hasContestedCorrectionWording=false・フラグ true（既定） → 足さない" +
      "（構造として非対称文面が出ていないため。opt-in のフラグそのものだけでは足さない）",
    () => {
      expect(resolveMnemoraAnswerSystemPrompt(false, true)).toBe(ANSWER_SYSTEM_PROMPT);
    },
  );

  it("hasContestedCorrectionWording=true・フラグ false → 足さない（フラグが off）", () => {
    expect(resolveMnemoraAnswerSystemPrompt(true, false)).toBe(ANSWER_SYSTEM_PROMPT);
  });

  it("hasContestedCorrectionWording=false・フラグ false → 足さない", () => {
    expect(resolveMnemoraAnswerSystemPrompt(false, false)).toBe(ANSWER_SYSTEM_PROMPT);
  });

  it("区切りに空白を挟まず、句点の直後にそのまま連結する", () => {
    const combined = resolveMnemoraAnswerSystemPrompt(true, true);
    expect(combined).toBe(
      "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。" +
        "矛盾候補の印がある記憶どうしは、記録順の新しい方を現在の値として答えてください。",
    );
  });
});
