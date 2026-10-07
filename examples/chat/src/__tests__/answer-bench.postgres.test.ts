import { afterAll, describe, expect, it } from "vitest";
import { createAnswerBenchRuntime, runAnswerCase, serializePromptSpec } from "../answer-bench.js";
import { checkContentPreserved } from "../answer-content-preservation.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { buildAnswerJson } from "../answer-json.js";
import { formatAnswerTable, formatAnswerQualityBanner } from "../answer-format.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

describe("examples/chat: answer（本物の Postgres、配線検査）", () => {
  it("naive/mnemora の両方が同じ system 文・同じ質問文で complete() を呼び、入力量を測れる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createAnswerBenchRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.llmMode).toBe("deterministic");
      const answerCase = ANSWER_CASE_SET_DEV[0]!;
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase,
        "answer-bench-test-wiring",
      );

      expect(result.naive.promptSpec.system).toBe(result.mnemora.promptSpec.system);
      expect(result.naive.promptSpec.system).toBeDefined();

      expect(result.naive.promptSpec.messages[0]?.content).toContain(answerCase.question);
      expect(result.mnemora.promptSpec.messages[0]?.content).toContain(answerCase.question);

      expect(result.naive.inputChars).toBeGreaterThan(0);
      expect(result.mnemora.inputChars).toBeGreaterThan(0);
      expect(result.naive.inputEstimatedTokens).toBeGreaterThan(0);
      expect(result.mnemora.inputEstimatedTokens).toBeGreaterThan(0);

      expect(result.naive.answer).toBe(result.naive.promptSpec.messages[0]?.content);
      expect(result.mnemora.answer).toBe(result.mnemora.promptSpec.messages[0]?.content);

      expect(result.cost.extractionLLMCalls).toBeGreaterThanOrEqual(1);
      expect(result.cost.embeddingCalls).toBeGreaterThanOrEqual(1);
      expect(result.cost.answerLLMCalls).toBe(2);
      expect(result.cost.judgeLLMCalls).toBe(2);

      expect(result.naive.judgement?.outcome).toBe("indeterminate");
      expect(result.mnemora.judgement?.outcome).toBe("indeterminate");
      expect(result.naive.reconciled).toBe("indeterminate");
      expect(result.mnemora.reconciled).toBe("indeterminate");

      expect(answerCase.expected.kind).toBe("closed-value");
      expect(result.naive.contentPreservation.applicable).toBe(true);
      expect(result.naive.contentPreservation.preserved).toBe(true);
      // mnemora 経路の値は recall() の選定次第なので固定しない（形だけを見る）。
      expect(typeof result.mnemora.contentPreservation.applicable).toBe("boolean");
      expect(typeof result.mnemora.contentPreservation.preserved).toBe("boolean");
    } finally {
      await handle.close();
    }
  });

  it("ケースごとに独立のテナントを使う——前のケースの記憶を引きずらない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createAnswerBenchRuntime(requireDatabaseUrl(), {});
    try {
      const [first, second] = ANSWER_CASE_SET_DEV;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const firstResult = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        first!,
        "answer-bench-test-isolation",
      );
      const secondResult = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        second!,
        "answer-bench-test-isolation",
      );
      expect(secondResult.mnemora.promptSpec.messages[0]?.content).not.toContain(
        first!.conversation[0]!.text,
      );
      expect(firstResult.mnemora.promptSpec.messages[0]?.content).not.toContain(
        second!.conversation[0]!.text,
      );
    } finally {
      await handle.close();
    }
  });

  it("🔴 deterministic では qualityClaimable=false になり、集計(summary)が出ない・表が `—` になる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createAnswerBenchRuntime(requireDatabaseUrl(), {});
    try {
      const answerCase = ANSWER_CASE_SET_DEV[0]!;
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase,
        "answer-bench-test-quality-gate",
      );

      const json = buildAnswerJson({
        results: [result],
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        measuredAt: new Date("2026-09-17T00:00:00.000Z"),
        commit: null,
      });
      expect(json.qualityClaimable).toBe(false);
      expect(json.summary).toBeUndefined();
      expect(json.inputReduction).toBeDefined();
      expect(json.inputReduction.naiveInputChars).toBeGreaterThan(0);

      const table = formatAnswerTable([result], handle.llmMode);
      expect(table).not.toMatch(/✅|❌|❓/);
      expect(table).toContain("—");

      const banner = formatAnswerQualityBanner(handle.llmMode);
      expect(banner).toContain("回答品質は測っていない");
    } finally {
      await handle.close();
    }
  });
  it("層2: naive も mnemora も、自分の promptSpec の直列化から計算した値と一致する（全 dev ケース）", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createAnswerBenchRuntime(requireDatabaseUrl(), {});
    try {
      let mnemoraDiffersFromNaive = false;
      const lossy = {
        ...ANSWER_CASE_SET_DEV[0]!,
        id: "lossy-derived",
        expected: {
          kind: "closed-value" as const,
          accept: ["そうですね、良い一日になりそうです"],
          reject: [],
        },
      };
      for (const answerCase of [...ANSWER_CASE_SET_DEV, lossy]) {
        const result = await runAnswerCase(
          handle.runtime,
          handle.llmProvider,
          handle.embeddingProvider,
          handle.judgeLLMProvider,
          answerCase,
          `answer-bench-test-own-prompt-${answerCase.id}`,
        );
        expect(result.naive.contentPreservation).toEqual(
          checkContentPreserved(serializePromptSpec(result.naive.promptSpec), answerCase.expected),
        );
        expect(result.mnemora.contentPreservation).toEqual(
          checkContentPreserved(
            serializePromptSpec(result.mnemora.promptSpec),
            answerCase.expected,
          ),
        );
        if (
          JSON.stringify(result.mnemora.contentPreservation) !==
          JSON.stringify(result.naive.contentPreservation)
        ) {
          mnemoraDiffersFromNaive = true;
        }
      }
      expect(mnemoraDiffersFromNaive).toBe(true);
    } finally {
      await handle.close();
    }
  }, 120_000);
});

afterAll(async () => {
  await closeTestClient();
});
