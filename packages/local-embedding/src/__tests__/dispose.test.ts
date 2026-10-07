import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import {
  buildLocalEmbeddingPipeline,
  type CreateLocalEmbeddingPipeline,
  type LocalEmbeddingExtractor,
  type LocalEmbeddingPipeline,
} from "../pipeline.js";

const ctx: Ctx = { tenantId: "test-tenant" };

interface Probe {
  disposeCalls: number;
  createCalls: number;
  pipeline: LocalEmbeddingPipeline & { dispose(): Promise<void> };
  createPipeline: CreateLocalEmbeddingPipeline;
}

function probe(options: { gate?: Promise<void> } = {}): Probe {
  const state: Probe = {
    disposeCalls: 0,
    createCalls: 0,
    pipeline: {
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      countTokens: (texts) => texts.map(() => 0),
      embed: async (texts) => texts.map(() => [1, 2]),
      dispose: async () => {
        state.disposeCalls += 1;
      },
    },
    createPipeline: async () => {
      state.createCalls += 1;
      if (options.gate !== undefined) {
        await options.gate;
      }
      return state.pipeline;
    },
  };
  return state;
}

function providerOf(p: Probe): LocalEmbeddingProvider {
  return new LocalEmbeddingProvider({ createPipeline: p.createPipeline, dimensions: 2 });
}

describe("LocalEmbeddingProvider.dispose()", () => {
  it("(a) 読み込み済みなら、pipeline の dispose を1回呼ぶ", async () => {
    const p = probe();
    const provider = providerOf(p);
    await provider.warmup();
    await provider.dispose();
    expect(p.disposeCalls).toBe(1);
  });

  it("(a) buildLocalEmbeddingPipeline は extractor の dispose まで届かせる", async () => {
    let extractorDisposed = 0;
    const extractor = Object.assign(async () => [[1, 2]], {
      tokenizer: { model_max_length: 512, encode: () => [1] },
      dispose: async () => {
        extractorDisposed += 1;
      },
    }) as unknown as LocalEmbeddingExtractor;
    const pipeline = buildLocalEmbeddingPipeline(extractor);
    await pipeline.dispose?.();
    expect(extractorDisposed).toBe(1);
  });

  it("(a) buildLocalEmbeddingPipeline は dispose を持たない extractor でも組み立てられる", () => {
    const extractor = Object.assign(async () => [[1, 2]], {
      tokenizer: { model_max_length: 512, encode: () => [1] },
    }) as unknown as LocalEmbeddingExtractor;
    expect(() => buildLocalEmbeddingPipeline(extractor)).not.toThrow();
  });

  it("一度も読み込んでいなければ、何もしない（読み込みも起こさない）", async () => {
    const p = probe();
    const provider = providerOf(p);
    await provider.dispose();
    expect(p.createCalls).toBe(0);
    expect(p.disposeCalls).toBe(0);
  });

  it("dispose を持たない pipeline を注入しても dispose() は通る", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => ({
        maxInputTokens: Number.MAX_SAFE_INTEGER,
        countTokens: (texts) => texts.map(() => 0),
        embed: async (texts) => texts.map(() => [1, 2]),
      }),
      dimensions: 2,
    });
    await provider.warmup();
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it("(b) dispose 後の embed は、分かる例外で断る（空配列でも、abort 済み signal でも）", async () => {
    const p = probe();
    const provider = providerOf(p);
    await provider.warmup();
    await provider.dispose();
    await expect(provider.embed(ctx, ["a"])).rejects.toThrow(/LocalEmbeddingProvider: .*dispose/);
    await expect(provider.embed(ctx, [])).rejects.toThrow(/dispose/);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.embed(ctx, ["a"], { signal: controller.signal })).rejects.toThrow(
      /dispose/,
    );
  });

  it("(b) dispose 後の warmup も断り、pipeline を作り直さない", async () => {
    const p = probe();
    const provider = providerOf(p);
    await provider.warmup();
    await provider.dispose();
    await expect(provider.warmup()).rejects.toThrow(/dispose/);
    expect(p.createCalls).toBe(1);
  });

  it("(b) 一度も読み込まずに dispose した後でも、embed は断り、読み込まない", async () => {
    const p = probe();
    const provider = providerOf(p);
    await provider.dispose();
    await expect(provider.embed(ctx, ["a"])).rejects.toThrow(/dispose/);
    expect(p.createCalls).toBe(0);
  });

  it("(c) 2回呼んでも安全で、上流の dispose は1回しか呼ばれない", async () => {
    const p = probe();
    const provider = providerOf(p);
    await provider.warmup();
    await provider.dispose();
    await provider.dispose();
    await Promise.all([provider.dispose(), provider.dispose()]);
    expect(p.disposeCalls).toBe(1);
  });

  it("(d) 読み込み中に dispose すると、読み込みの完了を待ってから解放する（漏らさない）", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const p = probe({ gate });
    const provider = providerOf(p);
    const warm = provider.warmup();
    while (p.createCalls === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
    let disposed = false;
    const disposing = provider.dispose().then(() => {
      disposed = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(disposed).toBe(false);
    expect(p.disposeCalls).toBe(0);

    open();
    await disposing;
    await warm;
    expect(p.disposeCalls).toBe(1);
    await expect(provider.embed(ctx, ["a"])).rejects.toThrow(/dispose/);
  });

  it("(d) 読み込みが失敗した場合、dispose は解放するものが無いだけで reject しない", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("boom");
      },
      dimensions: 2,
      retry: { attempts: 1 },
    });
    await expect(provider.warmup()).rejects.toThrow();
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it("(d) 走っている embed が終わるのを待ってから解放する", async () => {
    let finish!: (v: number[][]) => void;
    const p = probe();
    p.pipeline.embed = () =>
      new Promise<number[][]>((resolve) => {
        finish = resolve;
      });
    const provider = providerOf(p);
    const running = provider.embed(ctx, ["a"]);
    while (finish === undefined) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const disposing = provider.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(p.disposeCalls).toBe(0);

    finish([[1, 2]]);
    await expect(running).resolves.toEqual([[1, 2]]);
    await disposing;
    expect(p.disposeCalls).toBe(1);
  });
});
