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
 * Issue #1403 の歯。`revision` を `main` 以外にしても、温めたキャッシュだけでオフラインで読める。
 *
 * `@huggingface/transformers@4.2.0` の読み込みの前段の確認（`get_pipeline_files`）は `revision` を運ばない。
 * 以前は `revision` を `pipeline()` に渡していたので、前段の確認だけが `main` の鍵を探し、温めていても
 * `resolve/main/config.json` へ出て失敗した。いまは既定の `createPipeline` が、`revision` を
 * `env.remotePathTemplate` に埋め込み、キャッシュの根を `<根>/<encodeURIComponent(revision)>` に分ける
 * （ADR 0365）。
 *
 * - ネットワークには出ない: 子プロセスの `env.fetch` は、呼ばれたら記録して必ず失敗する。
 * - 本物の重みは要らない: 置くのは中身の無い偽のファイルで、この歯が見るのは「外へ出ようとしたか・どこへ」
 *   だけである（出なかった場合も、偽のファイルを解釈する段で読み込みは失敗する）。
 * - 既定のキャッシュは、子プロセスの `env.cacheDir` を一時ディレクトリへ向けて模す。
 * - `createLocalEmbeddingPipeline` は**ビルド済みの dist** から読む（`@mnemora/local-embedding` の入口）。
 *   走らせる前に `pnpm --filter @mnemora/local-embedding run build` が要る。
 */

const PROBE = fileURLToPath(
  new URL("./fixtures/probe-preflight-default-cache.mjs", import.meta.url),
);
const REPO = DEFAULT_LOCAL_EMBEDDING_REPO;
/** 40桁の commit sha の形なら何でもよい（ネットワークには出ない）。 */
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface ProbeResult {
  readonly fetchCount: number;
  readonly urls: string[];
  readonly outcome: "loaded" | "failed";
  readonly error: string | null;
}

let root: string;
let defaultCacheDir: string;
let cacheDir: string;

/** `<dir>/<encodeURIComponent(revision)>/<repo>/` に、偽の4ファイルを置く。 */
async function warm(dir: string, revision: string): Promise<void> {
  const files: [string, string][] = [
    ["config.json", JSON.stringify({ model_type: "modernbert" })],
    ["tokenizer_config.json", "{}"],
    ["tokenizer.json", "{}"],
    ["onnx/model_quantized.onnx", "not a model"],
  ];
  for (const [file, content] of files) {
    const target = path.join(dir, encodeURIComponent(revision), REPO, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function probe(cacheDirArg: string, revision: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [PROBE, defaultCacheDir, cacheDirArg, REPO, DEFAULT_LOCAL_EMBEDDING_DTYPE, revision],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as ProbeResult;
}

function expectNoNetwork(result: ProbeResult): void {
  expect(result.urls).toEqual([]);
  expect(result.fetchCount).toBe(0);
  // 読み込みの成否はこの歯の主張ではない（偽のファイルなので、ネットワークに出ずにその先で失敗する）。
  expect(result.error ?? "").not.toContain("network is disabled");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mnemora-local-embedding-revision-"));
  defaultCacheDir = path.join(root, "default-cache");
  cacheDir = path.join(root, "cache-dir");
  await mkdir(defaultCacheDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createLocalEmbeddingPipeline({ revision }): 温めた revision の根だけで、前段の確認もネットワークへ出ない（Issue #1403）", () => {
  it("cacheDir の <revision>/ の根に4ファイルが揃っていれば、既定のキャッシュが空でも、ネットワークへの要求は0回", async () => {
    await warm(cacheDir, SHA);
    expectNoNetwork(await probe(cacheDir, SHA));
  }, 90_000);

  it("cacheDir を渡さなくても、既定のキャッシュの <revision>/ の根に揃っていれば、ネットワークへの要求は0回", async () => {
    await warm(defaultCacheDir, SHA);
    expectNoNetwork(await probe("-", SHA));
  }, 90_000);

  it("revision に / を含む枝名でも、encodeURIComponent した名前の根に揃っていれば、ネットワークへの要求は0回", async () => {
    await warm(cacheDir, "refs/pr/1");
    expectNoNetwork(await probe(cacheDir, "refs/pr/1"));
  }, 90_000);

  it("温めていなければ、前段の確認も含め、取りに行く URL はどれも固定した revision のもの（main ではない）", async () => {
    const result = await probe(cacheDir, SHA);
    expect(result.fetchCount).toBeGreaterThan(0);
    for (const url of result.urls) {
      expect(url).toContain(`/resolve/${SHA}/`);
      expect(url).not.toContain("/resolve/main/");
    }
  }, 90_000);

  it("revision 無しで温めた中身（<repo>/ の直下）は、revision を渡した読み込みには使われない", async () => {
    // `main` の鍵の形で置く。根を revision ごとに分けていなければ、これが固定した revision の中身として読まれる。
    for (const file of ["config.json", "tokenizer_config.json"]) {
      const target = path.join(cacheDir, REPO, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        file === "config.json" ? JSON.stringify({ model_type: "modernbert" }) : "{}",
      );
    }
    const result = await probe(cacheDir, SHA);
    expect(result.fetchCount).toBeGreaterThan(0);
    expect(result.urls[0]).toContain(`/resolve/${SHA}/`);
  }, 90_000);
});
