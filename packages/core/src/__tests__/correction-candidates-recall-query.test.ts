import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewRecallRecord } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** postgres 側の `correction-candidates-recall-record.postgres.test.ts` は `toMatchObject({ text })` なので余計な欄が混ざっても緑になる。ここでは recall の記録の数と `query` 全体を見る。 */

const ctx: Ctx = { tenantId: "tenant-1" };

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

describe("runtime.findCorrectionCandidates: recall は1回だけ、text 以外を変えずに呼ぶ", () => {
  it.each([
    ["text だけ", { text: "大阪に引っ越した" }],
    [
      "limit と excludeMemoryIds も渡す",
      { text: "大阪に引っ越した", limit: 1, excludeMemoryIds: ["m-x"] },
    ],
  ] as const)(
    "%s: recall の記録は1件で、query は { text } と完全に等しい",
    async (_label, input) => {
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
      const recalls = (
        stores.memoryStore as unknown as { backing: { recalls: Map<string, NewRecallRecord> } }
      ).backing.recalls;

      const result = await runtime.findCorrectionCandidates(ctx, {
        ...input,
        excludeMemoryIds: "excludeMemoryIds" in input ? [...input.excludeMemoryIds] : undefined,
      });

      expect({
        recallIds: [...recalls.keys()],
        query: recalls.get(result.recallId)?.query,
      }).toEqual({
        recallIds: [result.recallId],
        query: { text: "大阪に引っ越した" },
      });
    },
  );
});
