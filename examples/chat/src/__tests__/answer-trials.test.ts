import { describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { loadAnswerTrialsMaterial } from "../answer-trials-material.js";
import {
  DEFAULT_ANSWER_TRIALS_N,
  DEFAULT_ANSWER_TRIALS_RENDERS,
  formatAnswerTrialsReport,
  parseAnswerTrialsN,
  parseAnswerTrialsRenders,
  runAnswerTrials,
} from "../answer-trials.js";

/**
 * `answer-trials.ts` の単体試験。**DB 不要・鍵不要**——`OPENAI_API_KEY` を一切使わない
 * （env にキーを渡さない・`llmProvider` を DI する）。実 API は1回も呼ばない（Issue #705）。
 */

/**
 * 「既知の形（回答プロンプト: system が含まれ、user メッセージが1件）」以外を受けたら
 * 例外を投げるモック。**カセットの形と完全に一致しない入力を受け取ったら黙って何か
 * 返すのではなく落ちる**——`answer-trials` が意図せず別の形のプロンプトを組んでいないかを
 * このモック自体が見張る。
 */
class StrictAnswerPromptMockLLMProvider implements LLMProvider {
  public receivedContents: string[] = [];
  constructor(private readonly answerByContentPrefix: (content: string) => string) {}

  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    if (req.system === undefined || req.system.length === 0) {
      throw new Error(
        "StrictAnswerPromptMockLLMProvider: system が無い(既知の回答プロンプトの形ではない)",
      );
    }
    if (req.messages.length !== 1 || req.messages[0]?.role !== "user") {
      throw new Error(
        "StrictAnswerPromptMockLLMProvider: messages が1件のuserメッセージではない(既知の回答プロンプトの形ではない)",
      );
    }
    const content = req.messages[0].content;
    const looksLikeAnswerPrompt =
      content.includes("質問: ") && (content.startsWith("- ") || content.startsWith("(索引:"));
    if (!looksLikeAnswerPrompt) {
      throw new Error(
        `StrictAnswerPromptMockLLMProvider: 既知の回答プロンプトの形ではない入力を受けた: ${JSON.stringify(content.slice(0, 80))}`,
      );
    }
    this.receivedContents.push(content);
    return { content: this.answerByContentPrefix(content) };
  }

  async completeStructured<T>(_ctx: Ctx, _req: StructuredRequest<T>): Promise<T> {
    throw new Error("StrictAnswerPromptMockLLMProvider: completeStructured は呼ばれない想定である");
  }
}

describe("parseAnswerTrialsN", () => {
  it("未指定なら既定値", () => {
    expect(parseAnswerTrialsN({})).toBe(DEFAULT_ANSWER_TRIALS_N);
    expect(parseAnswerTrialsN({ MNEMORA_ANSWER_TRIALS_N: "" })).toBe(DEFAULT_ANSWER_TRIALS_N);
  });

  it("正の整数はそのまま使う", () => {
    expect(parseAnswerTrialsN({ MNEMORA_ANSWER_TRIALS_N: "3" })).toBe(3);
  });

  it("0以下・非整数は例外", () => {
    expect(() => parseAnswerTrialsN({ MNEMORA_ANSWER_TRIALS_N: "0" })).toThrow();
    expect(() => parseAnswerTrialsN({ MNEMORA_ANSWER_TRIALS_N: "-1" })).toThrow();
    expect(() => parseAnswerTrialsN({ MNEMORA_ANSWER_TRIALS_N: "abc" })).toThrow();
    expect(() => parseAnswerTrialsN({ MNEMORA_ANSWER_TRIALS_N: "1.5" })).toThrow();
  });
});

describe("parseAnswerTrialsRenders", () => {
  it("未指定なら既定順(recorded, digest-only)", () => {
    expect(parseAnswerTrialsRenders({})).toEqual([...DEFAULT_ANSWER_TRIALS_RENDERS]);
  });

  it("カンマ区切りで指定順を守る", () => {
    expect(
      parseAnswerTrialsRenders({ MNEMORA_ANSWER_TRIALS_RENDERS: "digest-only,recorded" }),
    ).toEqual(["digest-only", "recorded"]);
  });

  it("未知の描画名は例外", () => {
    expect(() => parseAnswerTrialsRenders({ MNEMORA_ANSWER_TRIALS_RENDERS: "nonsense" })).toThrow();
  });
});

describe("runAnswerTrials(OPENAI_API_KEY 無し)", () => {
  it("実 API を一度も呼ばずに evaluated:false を返す", async () => {
    const material = loadAnswerTrialsMaterial();
    const result = await runAnswerTrials({ env: {}, material, n: 1 });
    expect(result.evaluated).toBe(false);
    if (result.evaluated) throw new Error("unreachable");
    expect(result.reason).toBe("no-api-key");
    // caseMaterials(指紋・文字数)は API を叩かなくても埋まる。
    expect(result.caseMaterials).toHaveLength(ANSWER_CASE_SET_DEV.length);
    expect(result.cassetteSha256).toBe(material.cassetteSha256);
  });

  it("formatAnswerTrialsReport が未評価の注記を含む", async () => {
    const material = loadAnswerTrialsMaterial();
    const result = await runAnswerTrials({ env: {}, material, n: 1 });
    expect(formatAnswerTrialsReport(result)).toContain("未評価");
  });
});

describe("runAnswerTrials(モック LLM を DI、n回試行)", () => {
  it("ケースごと・描画ごとに n 回呼び、正答数を数える", async () => {
    const material = loadAnswerTrialsMaterial();
    const prefCase = ANSWER_CASE_SET_DEV.find((c) => c.id === "pref-tea-over-coffee");
    if (prefCase === undefined) throw new Error("test fixture: pref-tea-over-coffee が無い");

    // 常に正解(accept[0])を返すモック。
    const provider = new StrictAnswerPromptMockLLMProvider(() => prefCase.expected.accept[0] ?? "");
    const result = await runAnswerTrials({
      llmProvider: provider,
      material,
      n: 3,
      renders: ["recorded", "digest-only"],
    });
    expect(result.evaluated).toBe(true);
    if (!result.evaluated) throw new Error("unreachable");

    const caseResult = result.caseResults.find((c) => c.caseId === "pref-tea-over-coffee");
    expect(caseResult).toBeDefined();
    for (const r of caseResult?.renders ?? []) {
      expect(r.n).toBe(3);
      expect(r.passCount).toBe(3);
      expect(r.failCount).toBe(0);
      expect(r.indeterminateCount).toBe(0);
    }
    // 呼び出し回数: 6ケース × 2描画 × 3回 = 36
    expect(provider.receivedContents).toHaveLength(ANSWER_CASE_SET_DEV.length * 2 * 3);
  });

  it("reject を返せば fail、空文字を返せば indeterminate になる(gradeAnswer をそのまま使っている)", async () => {
    const material = loadAnswerTrialsMaterial();
    const scheduleCase = ANSWER_CASE_SET_DEV.find((c) => c.id === "schedule-change-meeting-day");
    if (scheduleCase === undefined) throw new Error("test fixture が無い");

    let call = 0;
    const answers = [
      scheduleCase.expected.reject[0] ?? "", // fail
      "", // indeterminate
      scheduleCase.expected.accept[0] ?? "", // pass
    ];
    const provider = new StrictAnswerPromptMockLLMProvider(() => {
      const a = answers[call % answers.length] ?? "";
      call += 1;
      return a;
    });
    const result = await runAnswerTrials({
      llmProvider: provider,
      material,
      n: 3,
      renders: ["recorded"],
    });
    if (!result.evaluated) throw new Error("unreachable");
    const caseResult = result.caseResults.find((c) => c.caseId === "schedule-change-meeting-day");
    const r = caseResult?.renders[0];
    expect(r?.passCount).toBe(1);
    expect(r?.failCount).toBe(1);
    expect(r?.indeterminateCount).toBe(1);
  });

  it("DI したモックの run では usage/costUsd を捏造しない(すべて0)", async () => {
    const material = loadAnswerTrialsMaterial();
    const provider = new StrictAnswerPromptMockLLMProvider(() => "分かりません");
    const result = await runAnswerTrials({
      llmProvider: provider,
      material,
      n: 1,
      renders: ["recorded"],
    });
    if (!result.evaluated) throw new Error("unreachable");
    expect(result.usage).toEqual({ chatCalls: 0, promptTokens: 0, completionTokens: 0 });
    expect(result.costUsd).toEqual({ inputUsd: 0, outputUsd: 0, totalUsd: 0 });
  });

  it("temperature は既定文字列(数値を捏造しない)", async () => {
    const material = loadAnswerTrialsMaterial();
    const provider = new StrictAnswerPromptMockLLMProvider(() => "分かりません");
    const result = await runAnswerTrials({
      llmProvider: provider,
      material,
      n: 1,
      renders: ["recorded"],
    });
    if (!result.evaluated) throw new Error("unreachable");
    expect(result.temperature).toBe("provider既定（未指定）");
  });

  it("caseMaterials に各描画のプロンプト文字数が入る", async () => {
    const material = loadAnswerTrialsMaterial();
    const provider = new StrictAnswerPromptMockLLMProvider(() => "分かりません");
    const result = await runAnswerTrials({
      llmProvider: provider,
      material,
      n: 1,
      renders: ["recorded", "digest-only"],
    });
    const cm = result.caseMaterials.find((c) => c.caseId === "pref-tea-over-coffee");
    expect(cm?.renders).toHaveLength(2);
    for (const r of cm?.renders ?? []) {
      expect(r.userContentChars).toBeGreaterThan(0);
      expect(r.systemChars).toBeGreaterThan(0);
    }
    // digest-only は由来タグなどが無い分、recorded より短いはず(このケースは記憶がある)。
    const recordedChars = cm?.renders.find((r) => r.renderName === "recorded")?.userContentChars;
    const digestOnlyChars = cm?.renders.find(
      (r) => r.renderName === "digest-only",
    )?.userContentChars;
    expect(digestOnlyChars).toBeLessThan(recordedChars ?? Number.POSITIVE_INFINITY);
  });
});
