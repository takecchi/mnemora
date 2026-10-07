import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";
import { isLocalEmbeddingProviderError } from "../errors.js";

const ctx: Ctx = { tenantId: "finite-components-test" };

function pipelineReturning(embed: (texts: string[]) => number[][]): CreateLocalEmbeddingPipeline {
  return async () => ({
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts: string[]) => texts.map(() => 0),
    embed: async (texts: string[]) => embed(texts),
  });
}

describe("embed(): 有限な成分は、値が大きくても小さくても負でも -0 でも、そのまま返す", () => {
  const FINITE_VECTORS: [string, number[]][] = [
    ["絶対値の大きな正の値", [1e7, 1]],
    ["絶対値の大きな負の値", [-1e7, 1]],
    ["0 に近い値", [1e-30, -1e-30]],
    ["-0", [-0, 1]],
    ["負の値", [-0.5, -0.25]],
  ];

  it.each(FINITE_VECTORS)("%s", async (_label, vector) => {
    const provider = new LocalEmbeddingProvider({
      dimensions: vector.length,
      createPipeline: pipelineReturning((texts) => texts.map(() => [...vector])),
    });

    const result = await provider.embed(ctx, ["テキスト"]);

    expect(result).toHaveLength(1);
    expect(result[0]!.map((x) => Object.is(x, -0))).toEqual(vector.map((x) => Object.is(x, -0)));
    expect(result[0]).toEqual(vector);
  });
});

describe("embed(): 件数が maxBatchSize を超えて分割されても、有限でない成分は同じ例外になる", () => {
  it("2つ目のチャンクの中の NaN は、分割前の通し番号で名指しされる（素の Error、kind なし）", async () => {
    const provider = new LocalEmbeddingProvider({
      dimensions: 2,
      maxBatchSize: 2,
      createPipeline: pipelineReturning((texts) =>
        texts.map((text) => (text === "d" ? [0.5, Number.NaN] : [0.5, 0.5])),
      ),
    });

    const error = await provider
      .embed(ctx, ["a", "b", "c", "d", "e"])
      .then(() => undefined)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(isLocalEmbeddingProviderError(error)).toBe(false);
    expect((error as Error).message).toMatch(/3 番目のベクトルの 1 番目の成分/);
  });

  it("分割されても、有限なベクトルだけなら全件がそのまま返る", async () => {
    const provider = new LocalEmbeddingProvider({
      dimensions: 2,
      maxBatchSize: 2,
      createPipeline: pipelineReturning((texts) => texts.map((_t, i) => [i, 1])),
    });

    const result = await provider.embed(ctx, ["a", "b", "c", "d", "e"]);

    expect(result).toHaveLength(5);
  });
});
