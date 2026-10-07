import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import type { Ctx } from "@mnemora/core";
import { DeterministicEmbeddingProvider } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 本物の `OpenAILLMProvider` で、`ObserveResult.extractionFailure.kind` まで通ることを測る。core の通しの歯（`packages/core/src/__tests__/runtime.test.ts`）が使う LLMProvider は `kind` を持つ素の `Error` を投げるだけの偽物で（core は provider パッケージを import できない）、本物が投げたものが core の catch を通って届くかはどこからも測られていない。
 * 実 API は叩かず、`client` に偽の HTTP client を注入する（`refusal.test.ts` と同じ形）。ストアは `@mnemora/testkit/fixtures` のインメモリ実装で、適合 suite の入力にはせず `Runtime` を動かす配線としてだけ使う。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildRuntimeWithResponse(response: unknown) {
  const memoryStore = new InMemoryMemoryStore();
  const outboxStore = new InMemoryOutboxStore(memoryStore.outboxJobs);
  const eventStore = new InMemoryEventStore(memoryStore);
  const vectorStore = new InMemoryVectorStore(memoryStore);
  const tenantSettingsStore = new InMemoryTenantSettingsStore();
  const embeddingProvider = new DeterministicEmbeddingProvider();

  const create = async () => response;
  const llmProvider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });

  const runtime = createRuntime({
    memoryStore,
    outboxStore,
    vectorStore,
    eventStore,
    tenantSettingsStore,
    llmProvider,
    embeddingProvider,
    hashContent,
  });

  return { runtime, memoryStore };
}

const refusalResponse = {
  choices: [
    {
      finish_reason: "stop",
      message: { refusal: "I can't help with that request.", content: null },
    },
  ],
};

const truncatedResponse = {
  choices: [
    {
      finish_reason: "length",
      message: { refusal: null, content: '{"memories":[{"content":"途中で切れ' },
    },
  ],
};

const successResponse = {
  choices: [
    {
      finish_reason: "stop",
      message: {
        refusal: null,
        content: JSON.stringify({
          memories: [{ content: "東京出張がある", provenanceKind: "stated" }],
        }),
      },
    },
  ],
};

describe("本物の OpenAILLMProvider → createRuntime(@mnemora/core) → observe() の通し", () => {
  it("拒否応答: extractionFailure.kind === 'refusal' まで届く", async () => {
    const { runtime } = buildRuntimeWithResponse(refusalResponse);

    const result = await runtime.observe(ctx, { kind: "utterance", text: "教えてほしい話" });

    expect(result.extractionFailure?.kind).toBe("refusal");
    expect(result.extractionFailure?.message).toMatch(/refused/);
  });

  it("拒否応答でも observe() は throw せず、全文フォールバックへ倒れて Memory が1件残る（飲み込みの維持）", async () => {
    const { runtime, memoryStore } = buildRuntimeWithResponse(refusalResponse);

    const result = await runtime.observe(ctx, { kind: "utterance", text: "教えてほしい話" });

    expect(result.extraction).toBe("llm_failed_whole_observation");
    expect(result.memoryIds).toHaveLength(1);
    const memory = await memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.content).toBe("教えてほしい話");
  });

  it("打ち切り応答（finish_reason: 'length'）: extractionFailure.kind === 'truncated' まで届く", async () => {
    const { runtime } = buildRuntimeWithResponse(truncatedResponse);

    const result = await runtime.observe(ctx, { kind: "utterance", text: "長い話の途中" });

    expect(result.extractionFailure?.kind).toBe("truncated");
    expect(result.extraction).toBe("llm_failed_whole_observation");
  });

  it("成功経路: extractionFailure は必ず null（『間違った有る』の逆側）", async () => {
    const { runtime } = buildRuntimeWithResponse(successResponse);

    const result = await runtime.observe(ctx, { kind: "utterance", text: "明日東京に出張します" });

    expect(result.extraction).toBe("ok");
    expect(result.extractionFailure).toBeNull();
    expect(result.memoryIds).toHaveLength(1);
  });
});
