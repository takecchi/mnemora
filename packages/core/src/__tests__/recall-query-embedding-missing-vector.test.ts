import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `recall()` のクエリ埋め込みで、`EmbeddingProvider.embed` が**ベクトルを1件も返さなかった**
 * （`[]`）ときも、ベクトル候補生成が走らなかったことを
 * `stage_skipped` / `candidate_generation` / `embedding_provider_unavailable` として名乗る。
 *
 * `docs/recall.md` §「埋め込み provider が使えない…場合、ベクトル候補生成という経路そのものが
 * 走らない。これは 0 件ではなく `…embedding_provider_unavailable` として記録する」。
 * 以前は、`embed` が例外を投げたときだけこれを積み、`[]` を返したときは `queryVector` が
 * `undefined` のまま ANN の段を黙って飛ばしていた——omission にも何も出ず、
 * 「ベクトル検索だけが止まった」ことが呼び出し側から見えなかった。
 *
 * embed ジョブの側で同じ入力（`[]`）を失敗として扱うのは
 * `embed-job-missing-vector.test.ts`（`EmbeddingProvider` の doc の 2026-09-27 追記）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const embeddingProvider: EmbeddingProvider = {
    space: stores.embeddingProvider.space,
    embed: async () => [],
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
});
