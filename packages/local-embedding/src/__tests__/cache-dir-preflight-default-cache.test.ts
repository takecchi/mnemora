import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_DTYPE,
  DEFAULT_LOCAL_EMBEDDING_REPO,
} from "../local-embedding-provider.js";

const execFileAsync = promisify(execFile);

/**
 * `createLocalEmbeddingPipeline` 経由で読み込む（`pipeline()` を直接呼ばない。直した対象そのものを通す）。
 * 子プロセスの `env.fetch` は呼ばれたら記録して必ず失敗する。`cacheDir` に置くのは中身の無い偽のファイルで、見るのは「外へ出ようとしたか・どこへ」だけ（読み込みの成否は主張しない）。
 * `@mnemora/local-embedding` はビルド済みの dist を使う（`probe-preflight-default-cache.mjs`）ので、走らせる前に `pnpm --filter @mnemora/local-embedding run build`（と `pnpm --filter @mnemora/core run build`）が要る。
 * この歯が赤くなるのは2通り: (a) `env.cacheDir` の差し替えが壊れた（退行）。(b) transformers.js の版が上がり、前段の確認自身が `cache_dir` を運ぶようになった（前進。その場合は差し替え自体が不要になりうる）。
 */

const PROBE = fileURLToPath(
  new URL("./fixtures/probe-preflight-default-cache.mjs", import.meta.url),
);
const REPO = DEFAULT_LOCAL_EMBEDDING_REPO;

interface ProbeResult {
  readonly fetchCount: number;
  readonly urls: string[];
  readonly outcome: "loaded" | "failed";
  readonly error: string | null;
}

let root: string;
let defaultCacheDir: string;
let cacheDir: string;

async function put(dir: string, file: string, content: string): Promise<void> {
  const target = path.join(dir, REPO, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function probe(): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [PROBE, defaultCacheDir, cacheDir, REPO, DEFAULT_LOCAL_EMBEDDING_DTYPE],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as ProbeResult;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mnemora-local-embedding-preflight-"));
  defaultCacheDir = path.join(root, "default-cache");
  cacheDir = path.join(root, "cache-dir");
  // 既定のキャッシュは常に空にする。直った振る舞いでは、そこに何も置かなくてよいことを主張するため。
  await mkdir(defaultCacheDir, { recursive: true });
  await put(cacheDir, "config.json", JSON.stringify({ model_type: "modernbert" }));
  await put(cacheDir, "tokenizer_config.json", "{}");
  await put(cacheDir, "tokenizer.json", "{}");
  await put(cacheDir, "onnx/model_quantized.onnx", "not a model");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createLocalEmbeddingPipeline({ cacheDir }): 既定のキャッシュが空でも、前段の確認はネットワークへ出ない（直った Issue #1239）", () => {
  it("cacheDir に4ファイルが揃っていれば、既定のキャッシュが空でも、ネットワークへの要求は0回", async () => {
    const result = await probe();
    expect(result.urls).toEqual([]);
    expect(result.fetchCount).toBe(0);
    expect(result.error ?? "").not.toContain("network is disabled");
  }, 90_000);
});
