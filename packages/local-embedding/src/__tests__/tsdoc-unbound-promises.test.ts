import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import {
  buildLocalEmbeddingPipeline,
  type CreateLocalEmbeddingPipeline,
  type LocalEmbeddingExtractor,
  type LocalEmbeddingPipeline,
} from "../pipeline.js";
import { LocalEmbeddingProviderError } from "../errors.js";

/**
 * TSDoc・README が約束していて、ほかのどのテストも縛っていなかった振る舞いを縛る
 * （provider の公開の口の棚卸し。今の振る舞いの固定であり、望ましい姿の主張ではない）。
 *
 * `createPipeline` を注入するか、偽の extractor を `buildLocalEmbeddingPipeline` に渡すだけで、
 * 本物のモデルは読まない（ネットワークにも出ない）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function vectors(count: number, dimensions = 256): number[][] {
  return Array.from({ length: count }, () => Array.from({ length: dimensions }, () => 0.1));
}

function unknownLimitPipeline(): Promise<LocalEmbeddingPipeline> {
  const extractor = Object.assign(async () => [], {
    tokenizer: { model_max_length: Infinity, encode: () => [] },
  }) as unknown as LocalEmbeddingExtractor;
  return Promise.resolve().then(() => buildLocalEmbeddingPipeline(extractor));
}

describe("warmup(): 読み込みに失敗すると reject する（TSDoc）", () => {
  it("種類の付いていない失敗は、retry を使い切った後、元の例外を cause に持つ Error で包む", async () => {
    const original = new Error("取得できない");
    let calls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        calls += 1;
        throw original;
      },
      retry: { attempts: 2, delayMs: () => 0 },
      sleep: async () => {},
    });
    const error = (await provider.warmup().then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason,
    )) as Error;
    expect(calls).toBe(2);
    expect(error.message).toMatch(/^LocalEmbeddingProvider: モデルを読み込めなかった/);
    expect(error.message).toContain("repo=sirasagi62/ruri-v3-30m-ONNX");
    expect(error.message).toContain("dtype=q8");
    expect(error.cause).toBe(original);
  });

  it("種類の付いた失敗（unknown_input_limit）は、リトライも包みもせずにそのまま投げる", async () => {
    let calls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        calls += 1;
        return unknownLimitPipeline();
      },
      sleep: async () => {},
    });
    const error = await provider.warmup().then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason,
    );
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(LocalEmbeddingProviderError);
    expect((error as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
    expect((error as Error).message).not.toContain("モデルを読み込めなかった");
  });
});

describe("buildLocalEmbeddingPipeline: mean pooling と L2 normalize で固定する（createLocalEmbeddingPipeline の doc）", () => {
  it("extractor を { pooling: 'mean', normalize: true } で呼ぶ", async () => {
    const extractor = vi.fn(async (texts: string[], _options: unknown) => vectors(texts.length));
    const pipeline = buildLocalEmbeddingPipeline(
      Object.assign(extractor, {
        tokenizer: { model_max_length: 10, encode: (text: string) => Array.from(text) },
      }) as unknown as LocalEmbeddingExtractor,
    );
    await pipeline.embed(["あ"]);
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(extractor.mock.calls[0]?.[1]).toEqual({ pooling: "mean", normalize: true });
  });
});

describe("retry.attempts: 0 以下は1回に丸める（コンストラクタのコメント）", () => {
  it.each([0, -1])("attempts: %d でも createPipeline は1回呼ばれる", async (attempts) => {
    let calls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        calls += 1;
        throw new Error("落ちる");
      },
      retry: { attempts },
      sleep: async () => {},
    });
    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(calls).toBe(1);
  });
});

describe("embed(): 受け取った配列を分割せずに1回で推論する（README の peak RSS の節）", () => {
  it("300件を渡すと、pipeline.embed は1回だけ、300件のまま呼ばれる", async () => {
    const embed = vi.fn(async (texts: string[]) => vectors(texts.length));
    const createPipeline: CreateLocalEmbeddingPipeline = async () => ({
      maxInputTokens: 10,
      countTokens: (texts) => texts.map(() => 1),
      embed,
    });
    const provider = new LocalEmbeddingProvider({ createPipeline });
    const texts = Array.from({ length: 300 }, (_, i) => String(i));
    await expect(provider.embed(ctx, texts)).resolves.toHaveLength(300);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]?.[0]).toHaveLength(300);
  });
});

describe("LocalEmbeddingProviderError の既定値（errors.ts）", () => {
  it("name は常に 'LocalEmbeddingProviderError'、detail は省けば null", () => {
    const error = new LocalEmbeddingProviderError("unknown_input_limit", "m");
    expect(error.name).toBe("LocalEmbeddingProviderError");
    expect(error.detail).toBeNull();
  });

  it("unknown_input_limit で組み立てに失敗したときの detail は null", () => {
    let thrown: unknown;
    try {
      buildLocalEmbeddingPipeline(
        Object.assign(async () => [], {
          tokenizer: { model_max_length: Infinity, encode: () => [] },
        }) as unknown as LocalEmbeddingExtractor,
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
    expect((thrown as LocalEmbeddingProviderError).name).toBe("LocalEmbeddingProviderError");
    expect((thrown as LocalEmbeddingProviderError).detail).toBeNull();
  });
});
