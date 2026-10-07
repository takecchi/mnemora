import { describe, expect, it } from "vitest";
import type { RecallResult, Runtime } from "@mnemora/core";
import {
  ANSWER_SYSTEM_PROMPT,
  CONTESTED_CORRECTION_GUIDANCE,
  CountingEmbeddingProvider,
  CountingLLMProvider,
  runAnswerBench,
  runAnswerCase,
} from "../answer-bench.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { PROVENANCE_PROMPT_CASES } from "./provenance-prompt-cases.js";

function asymmetricRecall(): RecallResult {
  const found = PROVENANCE_PROMPT_CASES.find(
    (c) => c.id === "contested-with-asymmetric-both-recorded",
  );
  if (found === undefined) {
    throw new Error("provenance-prompt-cases.ts に contested-with-asymmetric-both-recorded が無い");
  }
  return {
    recallId: "recall-contested-guidance-default",
    memories: found.memories,
    omitted: [],
    index: { groups: [], totalInScope: found.memories.length, countKind: "exact" },
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

function fakeRuntime(recall: RecallResult): Runtime {
  return {
    observe: async () => ({ memoryIds: [] }),
    tick: async () => ({ processed: 0, failed: 0, unsupported: [], leaseConflicts: [] }),
    recall: async () => recall,
  } as unknown as Runtime;
}

function providers() {
  const llm = new CountingLLMProvider({
    complete: async () => ({ content: "回答" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  });
  const judge = new CountingLLMProvider({
    complete: async () => ({ content: "判定: 不明" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  });
  const embedding = new CountingEmbeddingProvider({
    space: { provider: "fake", model: "fake", dimensions: 2 },
    embed: async (_ctx, texts) => texts.map(() => [1, 0]),
  });
  return { llm, judge, embedding };
}

describe("矛盾候補の一文（案3）の既定はオン", () => {
  it("runAnswerCase: 引数を省くと、非対称文面が出た回の mnemora 側の system に一文が足され、naive 側は変わらない", async () => {
    const { llm, judge, embedding } = providers();
    const result = await runAnswerCase(
      fakeRuntime(asymmetricRecall()),
      llm,
      embedding,
      judge,
      ANSWER_CASE_SET_DEV[0]!,
      "contested-guidance-default",
    );
    expect(result.mnemora.promptSpec.system).toBe(
      `${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`,
    );
    expect(result.naive.promptSpec.system).toBe(ANSWER_SYSTEM_PROMPT);
  });

  it("runAnswerCase: false を明示すると、足されない", async () => {
    const { llm, judge, embedding } = providers();
    const result = await runAnswerCase(
      fakeRuntime(asymmetricRecall()),
      llm,
      embedding,
      judge,
      ANSWER_CASE_SET_DEV[0]!,
      "contested-guidance-off",
      {},
      undefined,
      false,
    );
    expect(result.mnemora.promptSpec.system).toBe(ANSWER_SYSTEM_PROMPT);
  });

  it("runAnswerBench: 引数を省くと、同じく既定オンで一文が足される", async () => {
    const { llm, judge, embedding } = providers();
    const results = await runAnswerBench(
      fakeRuntime(asymmetricRecall()),
      llm,
      embedding,
      judge,
      [ANSWER_CASE_SET_DEV[0]!],
      "contested-guidance-bench-default",
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.mnemora.promptSpec.system).toBe(
      `${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`,
    );
  });
});
