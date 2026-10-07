import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import type { AnswerCase } from "../answer-case.js";
import { checkContentPreserved } from "../answer-content-preservation.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import {
  buildNaiveAnswerPromptSpec,
  serializePromptSpec,
  ANSWER_SYSTEM_PROMPT,
} from "../answer-bench.js";
import { buildMnemoraPrompt } from "../mnemora-path.js";

function buildFakeRecallWithDigests(digests: readonly string[]): RecallResult {
  return {
    recallId: "recall-content-preservation-test",
    memories: digests.map((digest, i) => ({
      memoryId: `mem-${i}`,
      digest,
      retrievedVia: "ann",
    })),
    omitted: [],
    index: { groups: [], totalInScope: digests.length, countKind: "exact" },
    usage: {},
    explain: { stages: [] },
  } as unknown as RecallResult;
}

const GENERIC_INFO_LOST_DIGEST = "[要約失敗。内容は保持していません]";

describe("checkContentPreserved: 単体（ケースの authoring とは独立の入力）", () => {
  it("closed-value: accept のいずれかが部分文字列として含まれれば preserved=true", () => {
    const expected = { kind: "closed-value" as const, accept: ["水曜"], reject: ["金曜"] };
    const result = checkContentPreserved("- 定例会議は水曜日に移す必要がある。", expected);
    expect(result.applicable).toBe(true);
    expect(result.preserved).toBe(true);
    expect(result.matchedAcceptTerms).toEqual(["水曜"]);
  });

  it("closed-value: accept がどれも含まれなければ preserved=false（陽性対照の芯）", () => {
    const expected = { kind: "closed-value" as const, accept: ["水曜"], reject: ["金曜"] };
    const result = checkContentPreserved(GENERIC_INFO_LOST_DIGEST, expected);
    expect(result.applicable).toBe(true);
    expect(result.preserved).toBe(false);
    expect(result.matchedAcceptTerms).toEqual([]);
  });

  it("accept に複数の言い換えがあるとき、どれか1つでも含まれれば preserved=true（any-match）", () => {
    const expected = {
      kind: "closed-value" as const,
      accept: ["9月10日", "9月"],
      reject: ["4月3日", "4月"],
    };
    const result = checkContentPreserved("- 妻の誕生日は9月10日である。", expected);
    expect(result.preserved).toBe(true);
    expect(result.matchedAcceptTerms.sort()).toEqual(["9月", "9月10日"]);
  });

  it("reject の語が混ざっていても、accept が見つかれば preserved は変わらない（reject は見ない）", () => {
    const expected = { kind: "closed-value" as const, accept: ["25日"], reject: ["20日"] };
    const digest =
      "- 報告書の提出期限は今月の20日である。\n- 提出期限を25日に延ばしてもらいたいという要望がある。";
    const result = checkContentPreserved(digest, expected);
    expect(result.preserved).toBe(true);
  });

  it("must-abstain: 内容に関わらず applicable=false・preserved=true（保持すべき事実が無い）", () => {
    const expected = {
      kind: "must-abstain" as const,
      accept: ["分かりません"],
      reject: ["A型"],
    };
    expect(checkContentPreserved("", expected)).toEqual({
      applicable: false,
      preserved: true,
      matchedAcceptTerms: [],
    });
    expect(checkContentPreserved("- A型です。", expected)).toEqual({
      applicable: false,
      preserved: true,
      matchedAcceptTerms: [],
    });
  });

  it("正規化を経由する（全角・句読点・大文字小文字の違いを無視する、normalizeForGrading 再利用）", () => {
    const expected = { kind: "closed-value" as const, accept: ["紅茶"], reject: ["コーヒー"] };
    expect(checkContentPreserved("私は「紅茶。」が好きです！", expected).preserved).toBe(true);
  });
});

describe("checkContentPreserved × 実ケース集合（dev + eval）: naive 経路は常に保持される", () => {
  const allCases: AnswerCase[] = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
  const closedValueCases = allCases.filter((c) => c.expected.kind === "closed-value");
  const unknownCases = allCases.filter((c) => c.expected.kind === "must-abstain");

  it(`closed-value ケースが1件以上ある（${closedValueCases.length}件）`, () => {
    expect(closedValueCases.length).toBeGreaterThan(0);
  });

  it.each(closedValueCases.map((c) => [c.id, c] as const))(
    "%s: naive 経路の入力に expected.accept が残っている",
    (_id, answerCase) => {
      const naiveSpec = buildNaiveAnswerPromptSpec(answerCase);
      const serialized = serializePromptSpec(naiveSpec);
      const result = checkContentPreserved(serialized, answerCase.expected);
      expect(result.applicable).toBe(true);
      expect(result.preserved).toBe(true);
    },
  );

  it.each(unknownCases.map((c) => [c.id, c] as const))(
    "%s（unknown 類）: naive 経路でも applicable=false のまま",
    (_id, answerCase) => {
      const naiveSpec = buildNaiveAnswerPromptSpec(answerCase);
      const serialized = serializePromptSpec(naiveSpec);
      const result = checkContentPreserved(serialized, answerCase.expected);
      expect(result.applicable).toBe(false);
      expect(result.preserved).toBe(true);
    },
  );

  it("system 文そのものには expected.accept の語が紛れ込んでいない（誤検出の土台が無いことの確認）", () => {
    for (const answerCase of closedValueCases) {
      const result = checkContentPreserved(ANSWER_SYSTEM_PROMPT, answerCase.expected);
      expect(result.preserved).toBe(false);
    }
  });
});

describe("checkContentPreserved × buildMnemoraPrompt: 同一出典のまま digest を欠落させる変異試験", () => {
  const closedValueDevCases = ANSWER_CASE_SET_DEV.filter((c) => c.expected.kind === "closed-value");

  it(`dev の closed-value ケースが1件以上ある（${closedValueDevCases.length}件）`, () => {
    expect(closedValueDevCases.length).toBeGreaterThan(0);
  });

  it.each(closedValueDevCases.map((c) => [c.id, c] as const))(
    "%s: digest から根拠ターンの文面を落とすと preserved=false（赤）、復元すると preserved=true（緑）",
    (_id, answerCase) => {
      const groundTurnTexts = answerCase.grounds.turnIndex.map(
        (i) => answerCase.conversation[i]!.text,
      );
      expect(groundTurnTexts.length).toBeGreaterThan(0); // closed-value は grounds が空ではない

      const recallInfoLost = buildFakeRecallWithDigests(
        groundTurnTexts.map(() => GENERIC_INFO_LOST_DIGEST),
      );
      const recallInfoKept = buildFakeRecallWithDigests(groundTurnTexts);

      const promptInfoLost = buildMnemoraPrompt(recallInfoLost);
      const promptInfoKept = buildMnemoraPrompt(recallInfoKept);

      const lostResult = checkContentPreserved(promptInfoLost, answerCase.expected);
      expect(lostResult.applicable).toBe(true);
      expect(lostResult.preserved).toBe(false);

      const keptResult = checkContentPreserved(promptInfoKept, answerCase.expected);
      expect(keptResult.applicable).toBe(true);
      expect(keptResult.preserved).toBe(true);

      expect(recallInfoLost.memories.map((m) => m.memoryId)).toEqual(
        recallInfoKept.memories.map((m) => m.memoryId),
      );
    },
  );
});

describe("checkContentPreserved: 正規化は両側に掛かり、accept は1つでも見つかれば保持（#699）", () => {
  it("プロンプト側だけが全角・大文字・句読点を含んでいても、accept（半角・小文字）と一致する", () => {
    const r = checkContentPreserved("Ｔｅａ、です", {
      kind: "closed-value",
      accept: ["tea"],
      reject: [],
    });
    expect(r).toEqual({ applicable: true, preserved: true, matchedAcceptTerms: ["tea"] });
  });

  it("accept 側だけが全角・大文字・句読点を含んでいても、プロンプト（半角・小文字）と一致する", () => {
    const r = checkContentPreserved("tea", {
      kind: "closed-value",
      accept: ["ＴＥＡ。"],
      reject: [],
    });
    expect(r).toEqual({ applicable: true, preserved: true, matchedAcceptTerms: ["ＴＥＡ。"] });
  });

  it("accept のうち片方だけがプロンプトにあれば保持で、見つかった1件だけを返す（全部は要求しない）", () => {
    const r = checkContentPreserved("会議は水曜です", {
      kind: "closed-value",
      accept: ["水曜", "金曜以外"],
      reject: [],
    });
    expect(r.preserved).toBe(true);
    expect(r.matchedAcceptTerms).toEqual(["水曜"]);
  });
});
