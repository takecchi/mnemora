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
 * Issue #1239 の直った振る舞いを縛る歯。README「`cacheDir` を渡すと、読み込みの前段の確認も
 * そこを見る」。
 *
 * `@huggingface/transformers@4.2.0` の `pipeline()` は、読み込みの前段の確認
 * （`get_pipeline_files` の中の `get_config` / `get_file_metadata`）で `config.json`・
 * `tokenizer_config.json` の有無を**既定のキャッシュ（`env.cacheDir`）だけ**で確かめ、
 * `cache_dir` オプションを運ばない。`createLocalEmbeddingPipeline`（`pipeline.ts`）は、
 * `spec.cacheDir` が指定されているとき、`pipeline()` を呼んでいる間だけ `env.cacheDir` を
 * 同じ場所へ差し替えることでこれを直す。
 *
 * - **`createLocalEmbeddingPipeline` 経由で読み込む**——`@huggingface/transformers` の
 *   `pipeline()` を直接呼ぶのではない（直した対象そのものを通す）。
 * - ネットワークには出ない: 子プロセスの `env.fetch` は、呼ばれたら記録して必ず失敗する。
 * - 本物の重みは要らない: `cacheDir` に置くのは中身の無い偽のファイルで、この歯が見るのは「外へ出ようと
 *   したか・どこへ」だけである（偽のファイルなので、この先の解釈は失敗してよい——読み込みの成否は
 *   この歯の主張ではない）。
 * - 既定のキャッシュは、子プロセスの `env.cacheDir` を一時ディレクトリへ向けて模す（本物の置き場には触らない）。
 * - `@mnemora/local-embedding` は**ビルド済みの dist**を使う（`probe-preflight-default-cache.mjs`
 *   の doc）——このテストを走らせる前に `pnpm --filter @mnemora/local-embedding run build`
 *   （と、依存する `pnpm --filter @mnemora/core run build`）が要る。
 *
 * ⭐ この歯が赤くなるのは2通りある——**転じて別の意味を持つ**——ので、赤くなったら理由を見分けること:
 * (a) `pipeline.ts` の `env.cacheDir` の差し替えが壊れた（退行）。
 * (b) transformers.js の版が上がり、前段の確認自身が `cache_dir` を運ぶようになった（前進。
 *     その場合はこの差し替え自体が不要になりうる——README と ADR 0361 を一緒に見直すこと）。
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
  // 既定のキャッシュは常に空にする——直った振る舞いでは、そこに何も置かなくてよいことを
  // 主張するため（旧い歯は、既定のキャッシュに手当てを置く形を縛っていた）。
  await mkdir(defaultCacheDir, { recursive: true });
  // `cacheDir` には4ファイルとも揃える（中身は偽物）。
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
    // 読み込みの成否はこの歯の主張ではない（偽のファイルなので、ネットワークに出ずにその先で失敗する）。
    expect(result.error ?? "").not.toContain("network is disabled");
  }, 90_000);
});
