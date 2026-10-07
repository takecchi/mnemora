import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { SourceMemoryForgottenError } from "../interfaces/memory-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-reextract-loop-abort" };

let contents: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" as const })),
    }),
};

describe("口の無い adapter のループで2件目の書き込みが打ち切られたとき、書いた分を隠さない（#1493 B7）", () => {
  it("1件目の memoryIds を返し、atomicity は store_unsupported、既存は置き換えない", async () => {
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
      relationStore: stores.relationStore,
    });
    contents = ["猫は3匹"];
    const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
    const existing = first.memoryIds[0]!;

    // 口（supersedeWithNewMemories）を隠し、2件目の createMemoryWithOutbox だけ forget 済みとして打ち切らせる。
    Object.defineProperty(stores.memoryStore, "supersedeWithNewMemories", {
      value: undefined,
      configurable: true,
    });
    const real = stores.memoryStore.createMemoryWithOutbox.bind(stores.memoryStore);
    let calls = 0;
    stores.memoryStore.createMemoryWithOutbox = (async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 2) throw new SourceMemoryForgottenError("createMemoryWithOutbox", [existing]);
      return real(...args);
    }) as typeof real;

    contents = ["猫を3匹飼っている", "犬を1匹飼っている"];
    const result = await runtime.reextract(ctx, first.observationId);

    expect(calls).toBe(2);
    expect(result.memoryIds).toHaveLength(1);
    expect(result.atomicity).toBe("store_unsupported");
    expect(result.extraction).toBe("ok");
    expect(result.supersededMemoryIds).toEqual([]);
    expect(result.skipped).toEqual([
      { kind: "status_not_active", memoryId: existing, status: "forgotten" },
    ]);
    expect((await stores.memoryStore.get(ctx, result.memoryIds[0]!))?.status).toBe("active");
    expect((await stores.memoryStore.get(ctx, existing))?.status).toBe("active");
  });
});
