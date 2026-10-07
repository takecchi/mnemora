import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEmbeddingPipeline, type LocalEmbeddingModelSpec } from "../pipeline.js";

const DEFAULT_TEMPLATE = "{model}/resolve/{revision}/";

const pipelineMock = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(
  () =>
    ({ cacheDir: "/default/cache", remotePathTemplate: "{model}/resolve/{revision}/" }) as {
      cacheDir: unknown;
      remotePathTemplate: unknown;
    },
);

vi.mock("@huggingface/transformers", () => ({ pipeline: pipelineMock, env: envMock }));

interface Observed {
  readonly cacheDir: unknown;
  readonly remotePathTemplate: unknown;
  readonly options: Record<string, unknown>;
}

function fakeExtractor() {
  return Object.assign(async () => ({ tolist: () => [] }), {
    tokenizer: { model_max_length: 8192 },
  });
}

function baseSpec(overrides: Partial<LocalEmbeddingModelSpec> = {}): LocalEmbeddingModelSpec {
  return {
    repo: "example/some-model",
    dtype: "q8",
    cacheDir: undefined,
    numThreads: 1,
    ...overrides,
  };
}

function observeCalls(outcome: "resolve" | "reject" = "resolve"): Observed[] {
  const observed: Observed[] = [];
  pipelineMock.mockImplementation(
    async (_task: string, _model: string, options: Record<string, unknown>) => {
      observed.push({
        cacheDir: envMock.cacheDir,
        remotePathTemplate: envMock.remotePathTemplate,
        options,
      });
      if (outcome === "reject") throw new Error("load failed");
      return fakeExtractor();
    },
  );
  return observed;
}

describe("createLocalEmbeddingPipeline: revision を env.remotePathTemplate に埋め込み、根を分ける（Issue #1403）", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    envMock.cacheDir = "/default/cache";
    envMock.remotePathTemplate = DEFAULT_TEMPLATE;
  });

  it("cacheDir と revision を渡すと、pipeline() の間は <cacheDir>/<revision> が根になり、template に revision が入り、revision は渡されない", async () => {
    const observed = observeCalls();
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache", revision: "abc123" }));
    expect(observed).toHaveLength(1);
    expect(observed[0]!.cacheDir).toBe("/my/cache/abc123");
    expect(observed[0]!.options.cache_dir).toBe("/my/cache/abc123");
    expect(observed[0]!.remotePathTemplate).toBe("{model}/resolve/abc123/");
    expect(Object.hasOwn(observed[0]!.options, "revision")).toBe(false);
  });

  it("cacheDir を渡さずに revision だけ渡すと、既定のキャッシュの下の <revision> が根になる", async () => {
    const observed = observeCalls();
    await createLocalEmbeddingPipeline(baseSpec({ revision: "abc123" }));
    expect(observed[0]!.cacheDir).toBe("/default/cache/abc123");
    expect(observed[0]!.options.cache_dir).toBe("/default/cache/abc123");
    expect(observed[0]!.remotePathTemplate).toBe("{model}/resolve/abc123/");
    expect(Object.hasOwn(observed[0]!.options, "revision")).toBe(false);
  });

  it("revision は encodeURIComponent してから、根と template に入れる", async () => {
    const observed = observeCalls();
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache/", revision: "refs/pr/1" }));
    expect(observed[0]!.cacheDir).toBe("/my/cache/refs%2Fpr%2F1");
    expect(observed[0]!.remotePathTemplate).toBe("{model}/resolve/refs%2Fpr%2F1/");
  });

  it("利用者が変えた remotePathTemplate を土台にする", async () => {
    envMock.remotePathTemplate = "mirror/{model}/{revision}/files/";
    const observed = observeCalls();
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache", revision: "abc123" }));
    expect(observed[0]!.remotePathTemplate).toBe("mirror/{model}/abc123/files/");
    expect(envMock.remotePathTemplate).toBe("mirror/{model}/{revision}/files/");
  });

  it("成功した後、env.cacheDir と env.remotePathTemplate は元の値に戻る", async () => {
    observeCalls();
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache", revision: "abc123" }));
    expect(envMock.cacheDir).toBe("/default/cache");
    expect(envMock.remotePathTemplate).toBe(DEFAULT_TEMPLATE);
  });

  it("失敗した後も、env.cacheDir と env.remotePathTemplate は元の値に戻る", async () => {
    observeCalls("reject");
    await expect(createLocalEmbeddingPipeline(baseSpec({ revision: "abc123" }))).rejects.toThrow(
      "load failed",
    );
    expect(envMock.cacheDir).toBe("/default/cache");
    expect(envMock.remotePathTemplate).toBe(DEFAULT_TEMPLATE);
  });

  it("revision を渡さなければ、template にも根にも触らない（#1239 の振る舞いのまま）", async () => {
    const observed = observeCalls();
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache" }));
    await createLocalEmbeddingPipeline(baseSpec());
    expect(observed.map((o) => [o.cacheDir, o.remotePathTemplate, o.options.cache_dir])).toEqual([
      ["/my/cache", DEFAULT_TEMPLATE, "/my/cache"],
      ["/default/cache", DEFAULT_TEMPLATE, undefined],
    ]);
    expect(observed.every((o) => !Object.hasOwn(o.options, "revision"))).toBe(true);
  });

  it("revision の有無が違う読み込みを並行させても、それぞれ自分の値しか見ない", async () => {
    const observed = observeCalls();
    await Promise.all([
      createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache", revision: "aaa" })),
      createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache" })),
      createLocalEmbeddingPipeline(baseSpec({ revision: "bbb" })),
    ]);
    expect(observed.map((o) => [o.cacheDir, o.remotePathTemplate])).toEqual([
      ["/my/cache/aaa", "{model}/resolve/aaa/"],
      ["/my/cache", DEFAULT_TEMPLATE],
      ["/default/cache/bbb", "{model}/resolve/bbb/"],
    ]);
    expect(envMock.cacheDir).toBe("/default/cache");
    expect(envMock.remotePathTemplate).toBe(DEFAULT_TEMPLATE);
  });

  it("埋め込めない（remotePathTemplate が文字列でない・根が無い）なら、今までどおり revision を pipeline() へ渡す", async () => {
    const observed = observeCalls();
    envMock.remotePathTemplate = undefined;
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache", revision: "abc123" }));
    envMock.remotePathTemplate = DEFAULT_TEMPLATE;
    envMock.cacheDir = null;
    await createLocalEmbeddingPipeline(baseSpec({ revision: "abc123" }));
    expect(observed[0]!.options.revision).toBe("abc123");
    expect(observed[0]!.options.cache_dir).toBe("/my/cache");
    expect(observed[1]!.options.revision).toBe("abc123");
    expect(Object.hasOwn(observed[1]!.options, "cache_dir")).toBe(false);
    expect(envMock.cacheDir).toBe(null);
  });

  it("利用者が変えた template に {revision} が複数あっても、すべて置き換える（生の {revision} を残さない）", async () => {
    const observed = observeCalls();
    envMock.remotePathTemplate = "{model}/resolve/{revision}/?rev={revision}";
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/my/cache", revision: "abc123" }));
    expect(observed[0]!.remotePathTemplate).toBe("{model}/resolve/abc123/?rev=abc123");
    expect(envMock.remotePathTemplate).toBe("{model}/resolve/{revision}/?rev={revision}");
  });

  it("既定のキャッシュの値が空文字なら、根が無いのと同じに扱う（'' の下に <revision> を作らない）", async () => {
    const observed = observeCalls();
    envMock.cacheDir = "";
    await createLocalEmbeddingPipeline(baseSpec({ revision: "abc123" }));
    expect(observed[0]!.options.revision).toBe("abc123");
    expect(Object.hasOwn(observed[0]!.options, "cache_dir")).toBe(false);
    expect(observed[0]!.cacheDir).toBe("");
    expect(observed[0]!.remotePathTemplate).toBe(DEFAULT_TEMPLATE);
    expect(envMock.cacheDir).toBe("");
  });
});
