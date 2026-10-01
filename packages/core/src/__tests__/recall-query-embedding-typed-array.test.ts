import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0452: `recall()` のクエリ埋め込みは、`Float32Array` などの数値の型付き配列も、配列と同じく受ける。
 * embed ジョブ（`processEmbedJob`）は型付き配列を受けて保存していたので、以前は ingest が通るのに、
 * recall だけが「ベクトルを返さなかった」（`embedding_provider_unavailable`、`no_vector`）になっていた。
 * 次元違い・有限でない成分は、型付き配列でも配列と同じく `embedding_provider_unavailable`。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const UNAVAILABLE = {
  kind: "stage_skipped",
  stage: "candidate_generation",
  reason: "embedding_provider_unavailable",
} as const;

function buildRuntime(makeVector: (dimensions: number) => unknown) {
  const stores = createFakeRuntimeStores();
  const searched: unknown[] = [];
  const search = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = ((...args: Parameters<typeof search>) => {
    searched.push(args[2]);
    return search(...args);
  }) as typeof search;
  const embeddingProvider: EmbeddingProvider = {
    space: stores.embeddingProvider.space,
    embed: async () => [makeVector(stores.embeddingProvider.space.dimensions) as number[]],
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
  return { runtime, searched };
}

describe("recall() — クエリ埋め込みが数値の型付き配列でも受ける（ADR 0452）", () => {
  it.each([
    ["Float32Array", (d: number) => new Float32Array(d).fill(0.5)],
    ["Float64Array", (d: number) => new Float64Array(d).fill(0.5)],
  ])(
    "%s: embedding_provider_unavailable を名乗らず、vectorStore へは普通の配列で渡る",
    async (_name, make) => {
      const { runtime, searched } = buildRuntime(make);

      const result = await runtime.recall(ctx, { text: "何かのクエリ" });

      expect(result.omitted).not.toContainEqual(expect.objectContaining(UNAVAILABLE));
      const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
      expect(trace?.executed).toBe(true);
      expect(searched).toHaveLength(1);
      expect(Array.isArray(searched[0])).toBe(true);
      expect(searched[0]).toEqual(Array.from(make((searched[0] as number[]).length)));
    },
  );

  it.each([
    ["次元違いの Float32Array", (d: number) => new Float32Array(d + 1).fill(0.5)],
    [
      "NaN を含む Float32Array",
      (d: number) => {
        const v = new Float32Array(d).fill(0.5);
        v[0] = Number.NaN;
        return v;
      },
    ],
    ["BigInt64Array（成分が数でない）", (d: number) => new BigInt64Array(d)],
    ["DataView", (d: number) => new DataView(new ArrayBuffer(d * 4))],
    ["length だけ持つオブジェクト", (d: number) => ({ length: d })],
    ["文字列", () => "0.5,0.5"],
  ])("%s は、配列のときと同じく embedding_provider_unavailable", async (_name, make) => {
    const { runtime, searched } = buildRuntime(make);

    const result = await runtime.recall(ctx, { text: "何かのクエリ" });

    expect(result.omitted).toContainEqual(expect.objectContaining(UNAVAILABLE));
    expect(searched).toHaveLength(0);
  });
});
