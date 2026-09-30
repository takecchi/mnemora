import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `recall()` のクエリ埋め込みで、provider が `space.dimensions` と違う長さのベクトルを返したときは、
 * 「provider が使えない」（`embedding_provider_unavailable`）として名乗る（2026-09-30、ADR 0393）。
 * ベクトルを返さなかった場合（`recall-query-embedding-missing-vector.test.ts`）と同じ理由に丸める。
 *
 * 以前は次元違いのまま vectorStore へ渡り、Postgres では `toComparableQuery` が全 0 に
 * 差し替えて `score_not_comparable` と記録された。provider によって記録される理由の名前が
 * 違っていた（local-embedding は throw するので `embedding_provider_unavailable`）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const embeddingProvider: EmbeddingProvider = {
    space: stores.embeddingProvider.space,
    embed: async () => [new Array<number>(stores.embeddingProvider.space.dimensions + 1).fill(0.5)],
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

describe("recall() — クエリ埋め込みが次元違いなら embedding_provider_unavailable を名乗る", () => {
  it("omitted に embedding_provider_unavailable が出て、score_not_comparable は出ず、candidate_generation は走らない", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.recall(ctx, { text: "何かのクエリ" });

    expect(result.omitted).toContainEqual(expect.objectContaining(UNAVAILABLE));
    expect(JSON.stringify(result.omitted)).not.toContain("score_not_comparable");
    const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
    expect(trace?.executed).toBe(false);
  });
});
