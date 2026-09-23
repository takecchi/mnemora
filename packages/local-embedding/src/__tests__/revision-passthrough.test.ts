import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import {
  createLocalEmbeddingPipeline,
  type CreateLocalEmbeddingPipeline,
  type LocalEmbeddingModelSpec,
} from "../pipeline.js";

/**
 * `revision` の素通し（Issue #597 の最小の形）。
 *
 * ⭐ **測っているのは2つの層である。**
 *
 * 1. `LocalEmbeddingProvider` の options に渡した `revision` が、注入点
 *    （`createPipeline`）へ渡る spec に載ること／省いたら `undefined` のままであること。
 * 2. `createLocalEmbeddingPipeline` が、spec の `revision` を transformers.js の
 *    `pipeline()` の options へ渡すこと／**省いたら鍵ごと渡さず、`revision` を足す前と
 *    同じ呼び出しになること**（既定値は変えない。transformers.js の既定 `"main"` のまま）。
 *
 * `@huggingface/transformers` は `vi.mock` で差し替えるので、本物のモデルも onnxruntime も
 * 読み込まない。
 *
 * ⚠ **この歯が測っていないこと**: `revision` を渡したときに transformers.js が実際に
 * その revision を落とすか（本物のモデルを落として確かめていない）。キャッシュ鍵
 * （ADR 0263）と、読み込んだ重みの指紋の照合（ADR 0253）が、固定した revision を
 * どう扱うか（Issue #597 では決めていない）。
 */

const pipelineMock = vi.hoisted(() => vi.fn());

vi.mock("@huggingface/transformers", () => ({ pipeline: pipelineMock }));

/** `buildLocalEmbeddingPipeline` が組み立てに要る最小の形の偽 extractor。 */
function fakeExtractor() {
  return Object.assign(async () => ({ tolist: () => [] }), {
    tokenizer: { model_max_length: 512 },
  });
}

const baseSpec: LocalEmbeddingModelSpec = {
  repo: "example/some-model",
  dtype: "q8",
  cacheDir: undefined,
  numThreads: 4,
};

describe("LocalEmbeddingProvider: options の revision が、注入点へ渡る spec に載る（Issue #597）", () => {
  function recorder() {
    const specs: LocalEmbeddingModelSpec[] = [];
    const createPipeline: CreateLocalEmbeddingPipeline = async (spec) => {
      specs.push(spec);
      throw new Error("記録だけして止める（モデルは読み込まない）");
    };
    return { specs, createPipeline };
  }

  it("revision を渡すと、spec.revision に載る", async () => {
    const r = recorder();
    const provider = new LocalEmbeddingProvider({
      createPipeline: r.createPipeline,
      revision: "0123abc",
      retry: { attempts: 1 },
    });
    await expect(provider.warmup()).rejects.toThrow();
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]?.revision).toBe("0123abc");
  });

  it("revision を省くと、spec.revision は undefined のまま（既定値を足さない）", async () => {
    const r = recorder();
    const provider = new LocalEmbeddingProvider({
      createPipeline: r.createPipeline,
      retry: { attempts: 1 },
    });
    await expect(provider.warmup()).rejects.toThrow();
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]?.revision).toBeUndefined();
  });
});

describe("createLocalEmbeddingPipeline: spec の revision を pipeline() へ素通しする（Issue #597）", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    pipelineMock.mockResolvedValue(fakeExtractor());
  });

  it("revision を渡すと、pipeline() の options に revision が入る", async () => {
    await createLocalEmbeddingPipeline({ ...baseSpec, revision: "0123abc" });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    const [task, repo, options] = pipelineMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(task).toBe("feature-extraction");
    expect(repo).toBe("example/some-model");
    expect(options.revision).toBe("0123abc");
  });

  it("revision を省くと、pipeline() の options に revision の鍵が無い（足す前と同じ呼び出し）", async () => {
    await createLocalEmbeddingPipeline(baseSpec);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    const options = pipelineMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.hasOwn(options, "revision")).toBe(false);
    // 足す前と同じ呼び出しであることを、options の形そのもので固定する。
    expect(options).toEqual({
      dtype: "q8",
      session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
    });
  });
});
