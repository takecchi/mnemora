import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// `trim` で空になる本文は断るが、`trim` が落とさない U+200B だけの本文は通す（observe の doc）。
// スキーマ単体の試験はあるので、ここは runtime.observe の入口から通ることを見る。

const ctx: Ctx = { tenantId: "tenant-observe-zero-width-only" };
const ZERO_WIDTH_ONLY = "​";

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({ memories: [{ content: "抽出した事実", provenanceKind: "stated" }] }),
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

describe("runtime.observe は、U+200B だけの本文を断らない", () => {
  it.each([
    { kind: "utterance" as const, input: { kind: "utterance" as const, text: ZERO_WIDTH_ONLY } },
    { kind: "event" as const, input: { kind: "event" as const, name: ZERO_WIDTH_ONLY } },
    {
      kind: "document" as const,
      input: { kind: "document" as const, content: ZERO_WIDTH_ONLY },
    },
  ])("$kind", async ({ input }) => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, input);

    expect(result.extraction).not.toBe("skipped");
    expect(result.memoryIds).toHaveLength(1);
    expect(await stores.memoryStore.getObservation(ctx, result.observationId)).not.toBeNull();
  });
});
