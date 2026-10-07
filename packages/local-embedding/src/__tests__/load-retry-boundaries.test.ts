import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline, LocalEmbeddingPipeline } from "../pipeline.js";
import { LocalEmbeddingProviderError } from "../errors.js";

const ctx: Ctx = { tenantId: "test-tenant" };

function pipelineOf(embed?: LocalEmbeddingPipeline["embed"]): LocalEmbeddingPipeline {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed: embed ?? (async (texts) => texts.map(() => [0, 1])),
  };
}

/** 先頭から `failures` 回だけ落ち、その後は成功する `createPipeline`。 */
function failingThenReady(failures: number) {
  const state = { calls: 0 };
  const createPipeline: CreateLocalEmbeddingPipeline = async () => {
    state.calls += 1;
    if (state.calls <= failures) throw new Error(`fetch failed ${state.calls}`);
    return pipelineOf();
  };
  return { state, createPipeline };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("読み込みの再試行の境界", () => {
  it("最初の読み込みが成功したら、待ちも delayMs の呼び出しも起きない", async () => {
    const { state, createPipeline } = failingThenReady(0);
    const waited: number[] = [];
    const delayCalls: number[] = [];
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      dimensions: 2,
      retry: {
        attempts: 5,
        delayMs: (attempt) => {
          delayCalls.push(attempt);
          return 1;
        },
      },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await provider.embed(ctx, ["a"]);

    expect(state.calls).toBe(1);
    expect(waited).toEqual([]);
    expect(delayCalls).toEqual([]);
  });

  it("途中で成功したら、そこで試すのも待つのも止める（失敗した回数だけ待つ）", async () => {
    const { state, createPipeline } = failingThenReady(2);
    const waited: number[] = [];
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      dimensions: 2,
      retry: { attempts: 5, delayMs: (attempt) => attempt * 10 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await expect(provider.embed(ctx, ["a"])).resolves.toEqual([[0, 1]]);

    expect(state.calls).toBe(3);
    expect(waited).toEqual([10, 20]);
  });

  it("リトライで成功したあとの embed() は、モデルを読み込み直さない", async () => {
    const { state, createPipeline } = failingThenReady(1);
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      dimensions: 2,
      sleep: async () => {},
    });

    await provider.embed(ctx, ["a"]);
    await provider.embed(ctx, ["b"]);
    await provider.warmup();

    expect(state.calls).toBe(2);
  });

  it("warmup() も同じ再試行で一時的な失敗を吸収する", async () => {
    const { state, createPipeline } = failingThenReady(2);
    const waited: number[] = [];
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      dimensions: 2,
      retry: { attempts: 3, delayMs: () => 7 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await expect(provider.warmup()).resolves.toBeUndefined();

    expect(state.calls).toBe(3);
    expect(waited).toEqual([7, 7]);
  });

  it("使い切って失敗した後の次の embed() は、また設定した回数まで試す", async () => {
    let calls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        calls += 1;
        throw new Error("落ちる");
      },
      dimensions: 2,
      retry: { attempts: 3 },
      sleep: async () => {},
    });

    await expect(provider.embed(ctx, ["a"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(calls).toBe(3);
    await expect(provider.embed(ctx, ["a"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(calls).toBe(6);
  });

  it("同時に来た複数の embed() が全部失敗しても、試す回数は呼び出しの数に比例しない", async () => {
    let calls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        calls += 1;
        throw new Error("落ちる");
      },
      dimensions: 2,
      retry: { attempts: 3 },
      sleep: async () => {},
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => provider.embed(ctx, ["a"])),
    );

    expect(results.map((r) => r.status)).toEqual(Array(6).fill("rejected"));
    expect(calls).toBe(3);
  });

  it("同時に来た複数の embed() は、途中で成功した1本の読み込みを共有する", async () => {
    const { state, createPipeline } = failingThenReady(1);
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      dimensions: 2,
      sleep: async () => {},
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => provider.embed(ctx, ["a"])));

    expect(results).toEqual(Array(5).fill([[0, 1]]));
    expect(state.calls).toBe(2);
  });

  it.each(["input_too_long", "unknown_input_limit"] as const)(
    "2回目の試行で出た kind=%s の失敗は、そこで止めて包まずそのまま投げる",
    async (kind) => {
      let calls = 0;
      const typed = new LocalEmbeddingProviderError(kind, "種類の付いた失敗");
      const waited: number[] = [];
      const provider = new LocalEmbeddingProvider({
        createPipeline: async () => {
          calls += 1;
          if (calls === 1) throw new Error("fetch failed");
          throw typed;
        },
        dimensions: 2,
        retry: { attempts: 5, delayMs: () => 1 },
        sleep: async (ms) => {
          waited.push(ms);
        },
      });

      await expect(provider.embed(ctx, ["a"])).rejects.toBe(typed);

      expect(calls).toBe(2);
      expect(waited).toEqual([1]);
    },
  );

  it("読み込み後の推論の失敗は、リトライも読み込み直しもせずそのまま投げる", async () => {
    let creates = 0;
    let embeds = 0;
    const inferenceError = new Error("推論の失敗");
    const waited: number[] = [];
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        creates += 1;
        return pipelineOf(async () => {
          embeds += 1;
          throw inferenceError;
        });
      },
      dimensions: 2,
      retry: { attempts: 3 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await expect(provider.embed(ctx, ["a"])).rejects.toBe(inferenceError);
    await expect(provider.embed(ctx, ["a"])).rejects.toBe(inferenceError);

    expect(embeds).toBe(2);
    expect(creates).toBe(1);
    expect(waited).toEqual([]);
  });

  it("delayMs を省くと、既定のバックオフ（200ms・400ms…を上限とする jitter）の値で待つ", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const waited: number[] = [];
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("落ちる");
      },
      dimensions: 2,
      retry: { attempts: 3 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await expect(provider.embed(ctx, ["a"])).rejects.toThrow(/モデルを読み込めなかった/);

    expect(waited).toEqual([100, 200]);
  });

  it("sleep を省くと、delayMs が返した時間だけ実際に待ってから次の試行を始める", async () => {
    vi.useFakeTimers();
    const { state, createPipeline } = failingThenReady(1);
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      dimensions: 2,
      retry: { attempts: 2, delayMs: () => 1_000 },
    });

    const promise = provider.embed(ctx, ["a"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual([[0, 1]]);
    expect(state.calls).toBe(2);
  });
});
