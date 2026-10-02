import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0502: 空白だけの本文は、LLM を呼ぶ前・何も書く前に ZodError で落ちる
 * （LLM が失敗しても、空白だけの active Memory は残らない）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

describe("runtime.observe: 空白だけの本文", () => {
  it.each([
    ["utterance", { kind: "utterance", text: "  \n　" }],
    ["event", { kind: "event", name: "\t " }],
    ["document", { kind: "document", content: " \n" }],
  ])("%s: ZodError、LLM は呼ばれず、何も書かれない", async (_kind, input) => {
    let llmCalls = 0;
    const llm: LLMProvider = {
      complete: async () => {
        llmCalls += 1;
        throw new Error("llm down");
      },
      completeStructured: async () => {
        llmCalls += 1;
        throw new Error("llm down");
      },
    };
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
    const backing = (
      stores.memoryStore as unknown as {
        backing: { observations: Map<string, unknown>; memories: Map<string, unknown> };
      }
    ).backing;

    const err = await runtime.observe(ctx, input as never).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.name).toBe("ZodError");
    expect(llmCalls).toBe(0);
    expect(backing.observations.size).toBe(0);
    expect(backing.memories.size).toBe(0);
  });
});
