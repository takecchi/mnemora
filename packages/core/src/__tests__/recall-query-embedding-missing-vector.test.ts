import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(embed: EmbeddingProvider["embed"] = async () => []) {
  const stores = createFakeRuntimeStores();
  const embeddingProvider: EmbeddingProvider = {
    space: stores.embeddingProvider.space,
    embed,
  };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

const UNAVAILABLE = {
  kind: "stage_skipped",
  stage: "candidate_generation",
  reason: "embedding_provider_unavailable",
} as const;

describe("recall() — クエリ埋め込みがベクトルを返さなかったら embedding_provider_unavailable を名乗る", () => {
  it("ANN だけのとき: omitted に embedding_provider_unavailable が出て、candidate_generation は走らない", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.recall(ctx, { text: "何かのクエリ" });

    expect(result.omitted).toContainEqual(expect.objectContaining(UNAVAILABLE));
    const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
    expect(trace?.executed).toBe(false);
  });

  it("ANN と語彙の2本のとき: 語彙は走って記憶が返り、ANN が止まったことは omitted に出る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "shared topic の記憶",
      contentHash: "recall-query-embedding-missing-vector",
      digest: "shared topic",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date(),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365,
      decayFloorAt: new Date(Date.now() + 365 * 24 * 3600_000),
      embeddingStatus: "ready",
    });

    const result = await runtime.recall(ctx, {
      text: "shared topic",
      channels: ["ann", "lexical"],
    });

    expect(result.memories).toHaveLength(1);
    expect(result.omitted).toContainEqual(expect.objectContaining(UNAVAILABLE));
  });

  it.each([
    ["null", [null]],
    ["undefined", [undefined]],
    ["文字列", ["abc"]],
  ])(
    "embed が配列でない要素（%s）を返したときも、投げずに embedding_provider_unavailable（cause: no_vector）を名乗る",
    async (_label, returned) => {
      const { runtime } = buildRuntime(
        (async () => returned) as unknown as EmbeddingProvider["embed"],
      );

      const result = await runtime.recall(ctx, { text: "何かのクエリ" });

      expect(result.omitted).toContainEqual({ ...UNAVAILABLE, cause: { kind: "no_vector" } });
      const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
      expect(trace?.executed).toBe(false);
    },
  );
});
