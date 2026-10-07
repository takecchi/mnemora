import { LocalEmbeddingProvider } from "@mnemora/local-embedding";
import { DeterministicEmbeddingProvider } from "@mnemora/testkit";
import { describe, expect, it } from "vitest";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";

// 期待文言は逐語で書く。WEIGHTS_UNAVAILABLE_PREFIX を import すると、自己整合するテストになる。
describe("warmupLocalEmbedding", () => {
  it("createPipeline が失敗したら ok:false になり、指定の文言と cause を含む", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("simulated network failure (test)");
      },
    });
    const outcome = await warmupLocalEmbedding(provider);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("重みを取得できなかったので、値は測っていない");
    expect(outcome.detail).toContain("simulated network failure (test)");
  });

  it("createPipeline が成功すれば ok:true になる(メトリクスの前段が通ることの確認)", async () => {
    const provider = new LocalEmbeddingProvider({
      // 上限の検査はここでは測らないので、ダミーの値で埋める。実モデルの上限値は書かない。
      createPipeline: async () => ({
        maxInputTokens: Number.MAX_SAFE_INTEGER,
        countTokens: (texts: string[]) => texts.map(() => 0),
        embed: async (texts: string[]) => texts.map(() => new Array(256).fill(0)),
      }),
    });
    const outcome = await warmupLocalEmbedding(provider);
    expect(outcome.ok).toBe(true);
  });

  it("LocalEmbeddingProvider 以外(擬似 provider)は対象外として ok:true になる", async () => {
    const provider = new DeterministicEmbeddingProvider({
      provider: "testkit",
      model: "deterministic",
      dimensions: 8,
    });
    const outcome = await warmupLocalEmbedding(provider);
    expect(outcome.ok).toBe(true);
  });

  it("2回失敗させても、そのたびに ok:false になる(1回の失敗で壊れたままにならない)", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("still down");
      },
    });
    const first = await warmupLocalEmbedding(provider);
    const second = await warmupLocalEmbedding(provider);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
  });
});
