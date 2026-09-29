#!/usr/bin/env node
/**
 * Issue #1239 の歯（`cache-dir-preflight-default-cache.test.ts`）が使う、専用の計測プロセス。
 *
 * `@mnemora/local-embedding`（**ビルド済みの dist**。`createLocalEmbeddingPipeline` 経由——
 * 直接 `@huggingface/transformers` の `pipeline()` を呼ぶのではない）に `cacheDir` を渡して
 * 読み込ませ、そのとき外へ出ようとした要求を数える。
 *
 * - `env.cacheDir`（transformers.js の既定のキャッシュ）を、引数の `<defaultCacheDir>` に向ける——
 *   テストが既定のキャッシュを空にできるようにするため。本物の既定の置き場
 *   （パッケージの中の `.cache/`）には触らない。
 * - `env.fetch` は、呼ばれたら記録して必ず失敗する（ネットワークに出ない）。
 * - **`@huggingface/transformers` を先に import して `env` を掴んでから、`@mnemora/local-embedding`
 *   を import する**——`createLocalEmbeddingPipeline` 自身は `@huggingface/transformers` を
 *   遅延 import するが、Node のモジュールキャッシュにより同じシングルトンを指すので、
 *   ここで行った `env` の差し替えは `createLocalEmbeddingPipeline` の内部にも効く。
 * - 読み込みそのものの成否は `outcome` に出すだけで、この歯の主張ではない（テストは偽のモデルの
 *   ファイルを置くので、ネットワークに出なくても、ファイルを解釈する段で失敗しうる）。
 *
 * ⚠ なぜ別プロセスか: transformers.js はファイルのメタデータの問い合わせをプロセスの中で
 * メモ化する（`measure-fetch-calls-in-fresh-node-process.mjs` の doc と同じ理由）。
 *
 * 使い方: node probe-preflight-default-cache.mjs <defaultCacheDir> <cacheDir> <repo> <dtype> [revision]
 *
 * - `<cacheDir>` に `-` を渡すと、`cacheDir` を渡さない（既定のキャッシュだけを使う）。
 * - `[revision]` を渡すと、`createLocalEmbeddingPipeline` の spec に `revision` として載せる（Issue #1403）。
 * 標準出力へ `{ fetchCount, urls, outcome, error }` を1行の JSON で出す。
 */
import process from "node:process";

const [, , defaultCacheDir, cacheDirArg, repo, dtype, revision] = process.argv;
const cacheDir = cacheDirArg === "-" ? undefined : cacheDirArg;
if (!defaultCacheDir || !cacheDirArg || !repo || !dtype) {
  console.error(
    "usage: probe-preflight-default-cache.mjs <defaultCacheDir> <cacheDir> <repo> <dtype>",
  );
  process.exit(2);
}

const { env } = await import("@huggingface/transformers");

env.cacheDir = defaultCacheDir;
/** @type {string[]} */
const urls = [];
env.fetch = async (input) => {
  urls.push(typeof input === "string" ? input : (input?.url ?? String(input)));
  throw new TypeError("fetch failed (probe-preflight-default-cache: network is disabled)");
};

const { createLocalEmbeddingPipeline } = await import("@mnemora/local-embedding");

let outcome = "loaded";
let error = null;
try {
  await createLocalEmbeddingPipeline({
    repo,
    dtype,
    cacheDir,
    numThreads: 1,
    ...(revision !== undefined ? { revision } : {}),
  });
} catch (err) {
  outcome = "failed";
  error = String(err?.message ?? err).slice(0, 300);
}

process.stdout.write(JSON.stringify({ fetchCount: urls.length, urls, outcome, error }) + "\n");
