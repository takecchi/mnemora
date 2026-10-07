import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-malformed-subject-opt-in" };

function makeRuntime(subjectId: string) {
  const llm: LLMProvider = {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_c, req) =>
      req.schema.parse({
        memories: [{ content: "猫が好き", provenanceKind: "stated", subjectId }],
      }),
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
    config: { acceptLlmSubjectIdWithoutCandidates: true },
  });
  return { runtime, stores };
}

async function observedSubject(subjectId: string): Promise<string | null | undefined> {
  const { runtime, stores } = makeRuntime(subjectId);
  const result = await runtime.observe(ctx, {
    kind: "utterance",
    text: "発話",
    externalId: "e1",
    subjectId: "alice",
    extract: "sync",
  });
  expect(result.memoryIds).toHaveLength(1);
  return (await stores.memoryStore.get(ctx, result.memoryIds[0]!))?.subjectId;
}

describe("opt-in（acceptLlmSubjectIdWithoutCandidates: true）で一覧を渡さないとき", () => {
  it.each([
    ["NUL", "ab\u0000cd"],
    ["孤立サロゲート", "ab\ud800cd"],
  ])(
    "LLM が返した %s を含む subjectId は弾き、observation の subjectId へ落とす",
    async (_n, bad) => {
      expect(await observedSubject(bad)).toBe("alice");
    },
  );

  it("対照: 保存できる subjectId は一覧に照らさず、そのまま Memory の主題になる", async () => {
    expect(await observedSubject("bob")).toBe("bob");
    expect(await observedSubject("a😀b")).toBe("a😀b");
  });
});
