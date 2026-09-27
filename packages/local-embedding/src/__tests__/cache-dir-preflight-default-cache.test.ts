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
 * Issue #1239（#1004）の今の振る舞いを縛る歯。README「オフラインで使うなら、既定のキャッシュも温める」。
 *
 * `cacheDir` にモデルの4ファイルが揃っていても、`@huggingface/transformers@4.2.0` の `pipeline()` は読み込みの
 * 前段の確認（`get_pipeline_files`）で `config.json`・`tokenizer_config.json` の有無を**既定のキャッシュ
 * （`env.cacheDir`）だけ**で確かめ、無ければネットワークへ取りに行く。既定のキャッシュにその2つが在れば、
 * ネットワークへの要求は0回になる。
 *
 * - ネットワークには出ない: 子プロセスの `env.fetch` は、呼ばれたら記録して必ず失敗する。
 * - 本物の重みは要らない: `cacheDir` に置くのは中身の無い偽のファイルで、この歯が見るのは「外へ出ようと
 *   したか・どこへ」だけである（出なかった場合も、偽のファイルを解釈する段で読み込みは失敗する）。
 * - 既定のキャッシュは、子プロセスの `env.cacheDir` を一時ディレクトリへ向けて模す（本物の置き場には触らない）。
 *
 * ⭐ transformers.js の版が上がり、前段の確認が `cache_dir` を運ぶようになれば、1つ目の歯が赤くなる
 * （要求が0回になる）。そのときは README の節とこの歯を一緒に直すこと。
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

describe("cacheDir を渡しても、読み込みの前段の確認は既定のキャッシュを見る（transformers.js 4.2.0、Issue #1239）", () => {
  it("既定のキャッシュが空なら、cacheDir に4ファイルが揃っていても config.json を取りにネットワークへ出て、読み込みは失敗する", async () => {
    const result = await probe();
    expect(result.urls).toEqual([`https://huggingface.co/${REPO}/resolve/main/config.json`]);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("network is disabled");
  }, 90_000);

  it("既定のキャッシュに config.json だけが在っても、tokenizer_config.json を確かめにネットワークへ出る", async () => {
    await put(defaultCacheDir, "config.json", JSON.stringify({ model_type: "modernbert" }));
    const result = await probe();
    expect(result.urls).toEqual([
      `https://huggingface.co/${REPO}/resolve/main/tokenizer_config.json`,
    ]);
  }, 90_000);

  it("既定のキャッシュに config.json と tokenizer_config.json の2つが在れば、ネットワークへの要求は0回", async () => {
    await put(defaultCacheDir, "config.json", JSON.stringify({ model_type: "modernbert" }));
    await put(defaultCacheDir, "tokenizer_config.json", "{}");
    const result = await probe();
    expect(result.urls).toEqual([]);
    // 読み込みの成否はこの歯の主張ではない（偽のファイルなので、ネットワークに出ずにその先で失敗する）。
    expect(result.error ?? "").not.toContain("network is disabled");
  }, 90_000);
});
