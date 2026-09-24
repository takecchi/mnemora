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

/**
 * `checkContentPreserved`（層2・回答に必要な情報の保持、Issue #693 / 親 #498）の単体試験。
 * **DB 不要・LLM 不要・鍵不要**——`answer-content-preservation.ts` は純関数であり、
 * ここで使う `ANSWER_CASE_SET_DEV`/`ANSWER_CASE_SET_EVAL`/`buildNaiveAnswerPromptSpec`/
 * `buildMnemoraPrompt` もすべて DB もネットワークも使わない（各自の docstring 参照）。
 *
 * ⚠ **`ANSWER_CASE_SET_EVAL` を読んでいる。** `docs/autonomy.md` §2.2 決定5 が禁じるのは
 * 「見て調整すること」であり、「見て評価に使うこと」ではない——ここでは `expected.accept`
 * を変えず、既存の値をそのまま使って検査を回しているだけである。この検査を書いた担い手は
 * eval ケースの中身を読んでいる（本文は既にこのファイルに書いてある）ことを、PR 本文に
 * 正直に記す。
 */

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
    // 両方が部分文字列として現れる場合、両方とも記録される（"9月10日" は "9月" も含む）。
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

/**
 * 実ケース集合（dev + eval）を使った、機械的に汎化した検査。
 *
 * `naive` 経路（全文、`buildNaiveAnswerPromptSpec`）は `recall()` に依らない純関数で
 * 組み立てられる（同関数の docstring）。`expected.accept` はケースの authoring 規約上、
 * 元の発話からの引用であるため、**全 closed-value ケースで naive 側は必ず
 * preserved=true になるはず**——これが崩れたら、ケースの authoring 自体（`expected.accept`
 * が会話の文言と一致していない）を疑う歯である。
 */
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
    // ANSWER_SYSTEM_PROMPT は固定文字列であり、ケースごとの正解語を含まない。
    for (const answerCase of closedValueCases) {
      const result = checkContentPreserved(ANSWER_SYSTEM_PROMPT, answerCase.expected);
      expect(result.preserved).toBe(false);
    }
  });
});

/**
 * ⭐ **本題（Issue #693 完了条件2）**: 同一出典のまま `digest` から答えの情報を削る
 * 陽性対照で `preserved=false`（赤）になり、復元すると `preserved=true`（緑）に戻る。
 *
 * ADR 0236（PR #523）は同じ形の変異を**1個の作り物のケース**（「青」という架空の答え）
 * だけに対して固定した。ここでは**実ケース集合の全 closed-value ケース**
 * （5類 × dev/eval、`grounds.turnIndex` で引いた実際の根拠ターンの文面）に対して同じ
 * 変異を汎化する——架空の正解語を新しく書き足さず、ケースが既に持っている
 * `grounds`/`expected.accept` だけを使う。
 *
 * **「同一出典のまま」の意味**: ここでは `memories[].memoryId` を固定したまま
 * （`mem-0`、両方の変異で同じ値）`digest` だけを2通り差し替える——`buildMnemoraPrompt`
 * は `digest` の中身だけを見て `memoryId` を見ない関数なので、出典（`memoryId`）が
 * 変わっていないことは構造的に保証される。`sourceObservationId` までの層1の追跡は
 * `provenance-trace.test.ts`（ADR 0236）がすでに固定しており、ここでは重複させない。
 */
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

      // 変異: 根拠ターンの文面を持つ digest → 情報を持たない汎用 digest に差し替える。
      // memoryId（"mem-0" 等）は変えない——出典は同一のまま。
      const recallInfoLost = buildFakeRecallWithDigests(
        groundTurnTexts.map(() => GENERIC_INFO_LOST_DIGEST),
      );
      const recallInfoKept = buildFakeRecallWithDigests(groundTurnTexts);

      const promptInfoLost = buildMnemoraPrompt(recallInfoLost);
      const promptInfoKept = buildMnemoraPrompt(recallInfoKept);

      // 赤: 情報を落とした digest では、答えに必要な語が入力から消えている。
      const lostResult = checkContentPreserved(promptInfoLost, answerCase.expected);
      expect(lostResult.applicable).toBe(true);
      expect(lostResult.preserved).toBe(false);

      // 緑: 根拠ターンの文面を戻すと、答えに必要な語が入力に戻る。
      const keptResult = checkContentPreserved(promptInfoKept, answerCase.expected);
      expect(keptResult.applicable).toBe(true);
      expect(keptResult.preserved).toBe(true);

      // memoryId は変異の前後で同一——「同一出典のまま」を型ではなく実際の値で確認する。
      expect(recallInfoLost.memories.map((m) => m.memoryId)).toEqual(
        recallInfoKept.memories.map((m) => m.memoryId),
      );
    },
  );
});
