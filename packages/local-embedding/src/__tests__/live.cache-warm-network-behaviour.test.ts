import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_DTYPE,
  DEFAULT_LOCAL_EMBEDDING_REPO,
} from "../local-embedding-provider.js";
import { createLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingModelSpec } from "../pipeline.js";

const execFileAsync = promisify(execFile);

/**
 * 既存の歯（`scripts/__tests__/ci-yml-local-embedding-cache-wiring.test.mjs` など）は `ci.yml` と呼び出し側ソースの文字列を走査するだけなので、`@huggingface/transformers` の版上げで cache の挙動が変わっても緑のまま通る。ここは本物のモデルを一度 cacheDir へ落とし（cold）、まっさらな別プロセスで同じ `cacheDir` から読み込んで（warm）、ネットワークへ出た回数と宛先を数える。
 * 要る条件は `MNEMORA_LIVE_LOCAL_EMBEDDING`（opt-in。課金は発生しない）。CI では常に skipped。
 * 「warm なら0回」は成立しない。`AutoTokenizer.from_pretrained` は `get_file_metadata(modelId, 'tokenizer_config.json', {})` を空の options で呼び、`cache_dir` を運ばないので、`env.cacheDir`（transformers.js 既定の `<パッケージ>/.cache/`）を見に行く。そのため warm でも `tokenizer_config.json` への Range リクエスト（`bytes=0-0`）がちょうど1回残る。この歯が固定するのはその「1回」で、0回になったら（transformers.js が直したか `env.cacheDir` を合わせたら）退行ではなく前進なので、この歯を一緒に更新すること。増えたら cache がさらに効かなくなったので調べること。
 * なお 36MB の `model_quantized.onnx`・`config.json`・`tokenizer.json` は warm なら一切再取得されない（否定側のアサーションが毎回確認する）。
 * 数えているのは `env.fetch`（hub.js の `getFile()` と `fetch_file_head()` は外部へ出るとき必ずここを通る）への呼び出しで、`node:fs` 経由の cache hit は数えない。
 */
const live = (process.env.MNEMORA_LIVE_LOCAL_EMBEDDING ?? "") !== "";

const MEASURE_SCRIPT = fileURLToPath(
  new URL("./fixtures/measure-fetch-calls-in-fresh-node-process.mjs", import.meta.url),
);

interface MeasuredCall {
  readonly url: string;
  readonly method: string;
  readonly range: string | null;
}

interface MeasureResult {
  readonly fetchCount: number;
  readonly calls: MeasuredCall[];
}

async function measureFetchCallsInFreshProcess(cacheDir: string): Promise<MeasureResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [MEASURE_SCRIPT, cacheDir, DEFAULT_LOCAL_EMBEDDING_REPO, DEFAULT_LOCAL_EMBEDDING_DTYPE, "1"],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 60_000 },
  );
  return JSON.parse(stdout) as MeasureResult;
}

describe("live: cacheDir が warm なとき、実際に何回・何にネットワークへ出るか (MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  it.skipIf(!live)(
    "cold で温めた cacheDir を、まっさらな別プロセスから読むと、重みは再取得されず、tokenizer_config.json への軽量な Range リクエストが1回だけ残る",
    async () => {
      const cacheDir = await mkdtemp(path.join(tmpdir(), "mnemora-local-embedding-cache-"));
      try {
        const spec: LocalEmbeddingModelSpec = {
          repo: DEFAULT_LOCAL_EMBEDDING_REPO,
          dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
          cacheDir,
          numThreads: 1,
        };
        const coldPipeline = await createLocalEmbeddingPipeline(spec);
        const coldVectors = await coldPipeline.embed(["温め用の文"]);
        expect(coldVectors).toHaveLength(1);
        expect(coldVectors[0]).toHaveLength(256);

        const warm = await measureFetchCallsInFreshProcess(cacheDir);

        // 報告に数字を持ち帰るため、有効桁を落とさずに出力する。
        console.error(
          `[warm cache network behaviour] fetchCount=${warm.fetchCount} calls=${JSON.stringify(warm.calls)}`,
        );

        const urls = warm.calls.map((call) => call.url);
        expect(urls.some((url) => url.includes("model_quantized.onnx"))).toBe(false);
        expect(urls.some((url) => url.includes("/config.json"))).toBe(false);
        expect(urls.some((url) => url.endsWith("/tokenizer.json"))).toBe(false);

        // 実測どおりの固定: `tokenizer_config.json` へのメタデータ確認（Range: bytes=0-0）が、warm でもちょうど1回残る。
        expect(warm.fetchCount).toBe(1);
        expect(warm.calls[0]?.url).toContain("tokenizer_config.json");
        expect(warm.calls[0]?.range).toBe("bytes=0-0");
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
