import { afterAll, describe, expect, it } from "vitest";
import { createAnswerBenchRuntime, runAnswerCase } from "../answer-bench.js";
import { gradeAnswer } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { judgeAnswer } from "../answer-judge.js";
import {
  RETENTION_MUTATION_CASE_ID,
  applyRetentionMutation,
} from "../answer-retention-mutation.js";
import { ANSWER_ORDER_LEGEND_CASSETTE_PATH, loadCassette } from "../cassette-io.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 変異後の outcome は録り直すと変わりうる（プロンプトの文言が変わるため）。録り直したら実測値で確かめ直すこと。
describe("examples/chat answer: 回答評価の陽性対照（記録の再生、Issue #498 完了条件4）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("digest から答えの語を落とすと一次判定・二次観測がともに pass でなくなり、復元すると pass に戻る", async () => {
    await resetTestDatabase();
    await getTestClient();

    const cassette = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH);
    const handle = await createAnswerBenchRuntime(
      requireDatabaseUrl(),
      { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
      { cassette },
    );
    try {
      expect(handle.llmMode).toBe("recorded");
      expect(handle.embeddingMode).toBe("recorded");

      const answerCase = ANSWER_CASE_SET_DEV.find((c) => c.id === RETENTION_MUTATION_CASE_ID);
      expect(answerCase).toBeDefined();

      const before = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase!,
        "answer-retention-positive-control",
      );
      expect(before.mnemora.verdict).toBe("pass");
      expect(before.mnemora.judgement?.outcome).toBe("pass");
      expect(before.mnemora.reconciled).toBe("pass");

      const mutatedPromptSpec = applyRetentionMutation(before.mnemora.promptSpec);
      const ctx = { tenantId: "answer-retention-positive-control-mutated" };
      const mutatedResponse = await handle.llmProvider.complete(ctx, mutatedPromptSpec);
      const mutatedVerdict = gradeAnswer(mutatedResponse.content, answerCase!.expected);

      const groundTurnTexts = answerCase!.grounds.turnIndex.map(
        (i) => answerCase!.conversation[i]!.text,
      );
      const mutatedJudgement = await judgeAnswer(handle.judgeLLMProvider, ctx, {
        question: answerCase!.question,
        expectedKind: answerCase!.expected.kind,
        rationale: answerCase!.grounds.rationale,
        groundTurnTexts,
        answer: mutatedResponse.content,
      });

      // outcome は indeterminate に丸めず、記録した具体値をそのまま固定する。
      expect(mutatedVerdict).toBe("fail");
      expect(mutatedJudgement.outcome).toBe("fail");

      const restoredResponse = await handle.llmProvider.complete(ctx, before.mnemora.promptSpec);
      const restoredVerdict = gradeAnswer(restoredResponse.content, answerCase!.expected);
      const restoredJudgement = await judgeAnswer(handle.judgeLLMProvider, ctx, {
        question: answerCase!.question,
        expectedKind: answerCase!.expected.kind,
        rationale: answerCase!.grounds.rationale,
        groundTurnTexts,
        answer: restoredResponse.content,
      });
      expect(restoredVerdict).toBe("pass");
      expect(restoredJudgement.outcome).toBe("pass");
    } finally {
      await handle.close();
    }
  }, 30_000);
});
