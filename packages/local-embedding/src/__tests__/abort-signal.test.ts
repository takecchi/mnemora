import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline, LocalEmbeddingPipeline } from "../pipeline.js";

const ctx: Ctx = { tenantId: "test-tenant" };

function fakeLocalEmbeddingPipeline(
  embed: (texts: string[]) => Promise<number[][]>,
): LocalEmbeddingPipeline {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed,
  };
}

describe("LocalEmbeddingProvider — AbortSignal", () => {
  it("呼ぶ前に既に abort 済みなら、pipeline の読み込みすら行わずに reject する", async () => {
    let createCalls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      createCalls += 1;
      return fakeLocalEmbeddingPipeline(async (texts) => texts.map(() => [0]));
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, dimensions: 2 });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.embed(ctx, ["a"], { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(createCalls).toBe(0);
  });

  it("既に abort 済みなら、空配列でも [] を返さず reject する（pipeline も読まない）", async () => {
    let createCalls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      createCalls += 1;
      return fakeLocalEmbeddingPipeline(async (texts) => texts.map(() => [0]));
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, dimensions: 2 });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.embed(ctx, [], { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(createCalls).toBe(0);
  });

  it("abort していない signal なら、空配列は [] を返す（pipeline も読まない）", async () => {
    let createCalls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      createCalls += 1;
      return fakeLocalEmbeddingPipeline(async (texts) => texts.map(() => [0]));
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, dimensions: 2 });
    const controller = new AbortController();

    await expect(provider.embed(ctx, [], { signal: controller.signal })).resolves.toEqual([]);
    expect(createCalls).toBe(0);
  });

  it("推論は最後まで走り、終わった時点で abort 済みならベクトルを返さずに reject する", async () => {
    let resolveEmbed: ((vectors: number[][]) => void) | undefined;
    const createPipeline: CreateLocalEmbeddingPipeline = async () =>
      fakeLocalEmbeddingPipeline(
        (texts) =>
          new Promise((resolve) => {
            resolveEmbed = resolve;
            void texts;
          }),
      );
    const provider = new LocalEmbeddingProvider({ createPipeline, dimensions: 2 });
    const controller = new AbortController();

    const promise = provider.embed(ctx, ["a"], { signal: controller.signal });
    let settled = false;
    promise.catch(() => {
      settled = true;
    });
    // モデルの読み込みの await を挟むため、`pipeline.embed` が実際に呼ばれて pending になるまで待ってから abort する。
    while (resolveEmbed === undefined) {
      await new Promise((r) => setTimeout(r, 0));
    }
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    resolveEmbed!([[1, 2]]);
    await expect(promise).rejects.toBe(controller.signal.reason);
  });

  it("abort されなければ、今までどおりベクトルを返す（既定の挙動は1バイトも変わらない）", async () => {
    const createPipeline: CreateLocalEmbeddingPipeline = async () =>
      fakeLocalEmbeddingPipeline(async (texts) => texts.map(() => [1, 2]));
    const provider = new LocalEmbeddingProvider({ createPipeline, dimensions: 2 });

    const vectors = await provider.embed(ctx, ["a"]);
    expect(vectors).toEqual([[1, 2]]);
  });
});
