#!/usr/bin/env node
/**
 * `env.cacheDir` を引数の `<defaultCacheDir>` に向ける。テストが既定のキャッシュを空にできるようにするため（本物の既定の置き場には触らない）。`env.fetch` は呼ばれたら記録して必ず失敗する。
 * `@huggingface/transformers` を先に import して `env` を掴んでから `@mnemora/local-embedding` を import する。`createLocalEmbeddingPipeline` は `@huggingface/transformers` を遅延 import するが、モジュールキャッシュで同じシングルトンを指すので、ここでの `env` の差し替えが内部にも効く。
 * 別プロセスで測る理由は `measure-fetch-calls-in-fresh-node-process.mjs` と同じ（メタデータの問い合わせがプロセス内でメモ化される）。
 * 使い方: node probe-preflight-default-cache.mjs <defaultCacheDir> <cacheDir> <repo> <dtype> [revision]
 * `<cacheDir>` に `-` を渡すと、`cacheDir` を渡さない（既定のキャッシュだけを使う）。
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
