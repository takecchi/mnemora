import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { LocalEmbeddingPipeline } from "../pipeline.js";

const ctx: Ctx = { tenantId: "test-tenant" };

function providerWith(embedCalls: string[][], onCall: (n: number) => void) {
  const pipeline: LocalEmbeddingPipeline = {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed: async (texts) => {
      embedCalls.push(texts);
      onCall(embedCalls.length);
      return texts.map(() => [0, 1]);
    },
  };
  return new LocalEmbeddingProvider({
    createPipeline: async () => pipeline,
    dimensions: 2,
    maxBatchSize: 2,
  });
}

describe("LocalEmbeddingProvider — チャンクの合間の abort（ADR 0445）", () => {
  it("1チャンク目の推論の途中で abort すると、残りのチャンクは推論せず signal.reason で reject する", async () => {
    const calls: string[][] = [];
    const controller = new AbortController();
    const reason = new Error("caller-reason");
    const provider = providerWith(calls, (n) => {
      if (n === 1) controller.abort(reason);
    });

    await expect(
      provider.embed(ctx, ["a", "b", "c", "d", "e", "f"], { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(calls).toEqual([["a", "b"]]);
  });

  it("陽性対照: abort しなければ全チャンクを推論して全ベクトルを返す", async () => {
    const calls: string[][] = [];
    const provider = providerWith(calls, () => {});
    const vectors = await provider.embed(ctx, ["a", "b", "c", "d", "e", "f"], {
      signal: new AbortController().signal,
    });
    expect(vectors).toHaveLength(6);
    expect(calls).toHaveLength(3);
  });
});
