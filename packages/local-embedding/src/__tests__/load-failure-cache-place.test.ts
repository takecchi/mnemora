import { describe, expect, it, vi } from "vitest";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

/**
 * pnpm で入れた利用者の実際の場所は `node_modules/.pnpm/@huggingface+transformers@<版>/node_modules/@huggingface/transformers/.cache/` で、npm の配置を決め打ちで名指すと、無い場所を「消せば取り直す」と指してしまう。既定の `createPipeline` は transformers.js を import した後で `env.cacheDir` を読めるので、その値を出す。
 * `@huggingface/transformers` は `vi.mock` で差し替えるので、本物のモデルも onnxruntime も読み込まない。
 */

const PNPM_CACHE_DIR =
  "/app/node_modules/.pnpm/@huggingface+transformers@4.2.0/node_modules/@huggingface/transformers/.cache/";

const transformers = vi.hoisted(() => ({
  env: { cacheDir: "" as string | null },
  pipeline: vi.fn(async () => {
    throw new Error("fetch failed");
  }),
}));

vi.mock("@huggingface/transformers", () => transformers);

async function loadFailure(): Promise<Error> {
  const provider = new LocalEmbeddingProvider({ retry: { attempts: 1 } });
  const error = await provider.warmup().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("読み込み失敗のメッセージは、実際に解決されたキャッシュの場所を名指す", () => {
  it("cacheDir 未指定・既定の pipeline: transformers.js の env.cacheDir（pnpm の配置）を名指す", async () => {
    transformers.env.cacheDir = PNPM_CACHE_DIR;
    const error = await loadFailure();
    expect(error.message).toContain(`既定: ${PNPM_CACHE_DIR}）`);
    expect(error.message).toContain(` ${PNPM_CACHE_DIR}sirasagi62/ruri-v3-30m-ONNX を消すと`);
    expect(error.message).not.toContain("既定: node_modules/");
    expect(error.message).not.toContain(" node_modules/@huggingface/transformers/.cache/");
  });

  it("env.cacheDir が無い（ファイルの置き場を持たない環境）なら、特定の場所を断言しない", async () => {
    transformers.env.cacheDir = null;
    const error = await loadFailure();
    expect(error.message).not.toContain("node_modules/@huggingface/transformers/.cache/");
    expect(error.message).toContain("env.cacheDir");
    expect(error.message).toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  it("env.cacheDir が空文字でも、特定の場所を断言しない（#1223）", async () => {
    transformers.env.cacheDir = "";
    const error = await loadFailure();
    expect(error.message).toContain("transformers.js の既定: transformers.js の env.cacheDir");
    expect(error.message).not.toContain("既定: ）");
    expect(error.message).not.toContain(" /sirasagi62/ruri-v3-30m-ONNX を消すと");
  });

  it("cacheDir を渡したときは、既定の場所ではなく渡した値を名指す（#1223）", async () => {
    transformers.env.cacheDir = PNPM_CACHE_DIR;
    const provider = new LocalEmbeddingProvider({ cacheDir: "/x/", retry: { attempts: 1 } });
    const error = (await provider.warmup().then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("cacheDir=/x/");
    expect(error.message).toContain(" /x/sirasagi62/ruri-v3-30m-ONNX を消すと");
    expect(error.message).not.toContain(PNPM_CACHE_DIR);
  });

  it("revision を渡したときは、消せば取り直す場所も <根>/<revision> の下を名指す（根を revision ごとに分けるため）", async () => {
    transformers.env.cacheDir = PNPM_CACHE_DIR;
    const withCacheDir = new LocalEmbeddingProvider({
      cacheDir: "/x/",
      revision: "abc123",
      retry: { attempts: 1 },
    });
    const withCacheDirError = (await withCacheDir.warmup().then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(withCacheDirError.message).toContain(" /x/abc123/sirasagi62/ruri-v3-30m-ONNX を消すと");

    const withDefault = new LocalEmbeddingProvider({ revision: "abc123", retry: { attempts: 1 } });
    const withDefaultError = (await withDefault.warmup().then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(withDefaultError.message).toContain(
      ` ${PNPM_CACHE_DIR}abc123/sirasagi62/ruri-v3-30m-ONNX を消すと`,
    );
  });

  // 記録はモジュール全体で共有される値なので、先に既定の pipeline を失敗させて記録を作り、
  // その後で注入した pipeline を失敗させる。古い記録が別の provider のメッセージに漏れてはならない。
  it("createPipeline を注入したときは、既定の pipeline が記録した場所を名指さない（#1223）", async () => {
    transformers.env.cacheDir = PNPM_CACHE_DIR;
    await loadFailure();
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("injected failure");
      },
      retry: { attempts: 1 },
    });
    const error = (await provider.warmup().then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(PNPM_CACHE_DIR);
    expect(error.message).toContain("env.cacheDir");
  });
});
