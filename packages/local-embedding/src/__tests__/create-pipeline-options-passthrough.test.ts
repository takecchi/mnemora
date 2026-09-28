import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEmbeddingPipeline, type LocalEmbeddingModelSpec } from "../pipeline.js";

/**
 * `createLocalEmbeddingPipeline` が、spec の `cacheDir` と `numThreads` を transformers.js の
 * `pipeline()` の options（`cache_dir`・`session_options.intraOpNumThreads`）へ渡すこと。
 *
 * `revision-passthrough.test.ts` が固定しているのは、`cacheDir` 未指定・スレッド数 4 の形だけだった。
 * ここでは既定と違う値を渡して、値がそのまま届くことを見る。`@huggingface/transformers` は `vi.mock` で
 * 差し替えるので、本物のモデルも onnxruntime も読み込まない。
 */

const pipelineMock = vi.hoisted(() => vi.fn());

vi.mock("@huggingface/transformers", () => ({ pipeline: pipelineMock }));

const spec: LocalEmbeddingModelSpec = {
  repo: "example/some-model",
  dtype: "fp32",
  cacheDir: "/var/lib/mnemora/models",
  numThreads: 7,
};

describe("createLocalEmbeddingPipeline: cacheDir と numThreads を pipeline() へ渡す", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    pipelineMock.mockResolvedValue(
      Object.assign(async () => ({ tolist: () => [] }), {
        tokenizer: { model_max_length: 512 },
      }),
    );
  });

  it("cache_dir・dtype・intraOpNumThreads に渡した値が入り、interOpNumThreads は 1", async () => {
    await createLocalEmbeddingPipeline(spec);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    const options = pipelineMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options).toEqual({
      dtype: "fp32",
      cache_dir: "/var/lib/mnemora/models",
      session_options: { intraOpNumThreads: 7, interOpNumThreads: 1 },
    });
  });
});
