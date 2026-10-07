import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 次元を4にして、短い側・空・長い側と、先頭・中間・末尾の非有限値を与える。Fake の次元（2）では長い側（+1）と先頭しか与えられず、検査の向きや走査が末尾を飛ばす変異に気づけない。 */
const ctx: Ctx = { tenantId: "tenant-1" };
const DIMS = 4;

function buildRuntime(vector: number[]) {
  const stores = createFakeRuntimeStores();
  const embeddingProvider: EmbeddingProvider = {
    space: { ...stores.embeddingProvider.space, dimensions: DIMS },
    embed: async () => [vector],
  };
  return createRuntime({
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
}

const UNAVAILABLE = {
  kind: "stage_skipped",
  stage: "candidate_generation",
  reason: "embedding_provider_unavailable",
} as const;

describe("recall() のクエリ埋め込み：次元違い・非有限の値の位置に依らず embedding_provider_unavailable（#1463 R4・R6）", () => {
  it.each([
    ["1つ短い", DIMS - 1],
    ["空", 0],
    ["1つ長い", DIMS + 1],
  ])(
    "%sベクトルは unavailable（dimension_mismatch）になり、score_not_comparable は出ない",
    async (_label, length) => {
      const runtime = buildRuntime(new Array<number>(length).fill(0.5));
      const result = await runtime.recall(ctx, { text: "何かのクエリ" });
      expect(result.omitted).toContainEqual(
        expect.objectContaining({ ...UNAVAILABLE, cause: { kind: "dimension_mismatch" } }),
      );
      expect(JSON.stringify(result.omitted)).not.toContain("score_not_comparable");
    },
  );

  it.each([
    ["先頭", 0],
    ["中間", 2],
    ["末尾", DIMS - 1],
  ])("非有限の値が%sにあっても unavailable（non_finite）になる", async (_label, index) => {
    const vector = new Array<number>(DIMS).fill(0.5);
    vector[index] = Number.POSITIVE_INFINITY;
    const runtime = buildRuntime(vector);
    const result = await runtime.recall(ctx, { text: "何かのクエリ" });
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ ...UNAVAILABLE, cause: { kind: "non_finite" } }),
    );
    const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
    expect(trace?.executed).toBe(false);
  });

  it("対照: 次元が合い、すべて有限なら unavailable にならない", async () => {
    const runtime = buildRuntime(new Array<number>(DIMS).fill(0.5));
    const result = await runtime.recall(ctx, { text: "何かのクエリ" });
    expect(JSON.stringify(result.omitted)).not.toContain("embedding_provider_unavailable");
  });
});
