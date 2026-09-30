import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `recall()` のクエリ埋め込みで、provider が `NaN`・`Infinity` を含むベクトルを返したときも、
 * 「provider が使えない」（`embedding_provider_unavailable`）として名乗る（2026-09-30、ADR 0393）。
 * 次元違い（`recall-query-embedding-dimension-mismatch.test.ts`）と同じ理由に丸める。
 *
 * 以前は vectorStore まで届き、Postgres では `toComparableQuery` が全 0 に差し替えて
 * `score_not_comparable` と記録された。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(bad: number) {
  const stores = createFakeRuntimeStores();
  const embeddingProvider: EmbeddingProvider = {
    space: stores.embeddingProvider.space,
    embed: async () => {
      const vec = new Array<number>(stores.embeddingProvider.space.dimensions).fill(0.5);
      vec[0] = bad;
      return [vec];
    },
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

describe("recall() — クエリ埋め込みが有限でない成分を含むなら embedding_provider_unavailable を名乗る", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "成分に %s を含むと、omitted に embedding_provider_unavailable が出て、score_not_comparable は出ず、candidate_generation は走らない",
    async (bad) => {
      const { runtime } = buildRuntime(bad);

      const result = await runtime.recall(ctx, { text: "何かのクエリ" });

      expect(result.omitted).toContainEqual(UNAVAILABLE);
      expect(JSON.stringify(result.omitted)).not.toContain("score_not_comparable");
      const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
      expect(trace?.executed).toBe(false);
    },
  );
});
