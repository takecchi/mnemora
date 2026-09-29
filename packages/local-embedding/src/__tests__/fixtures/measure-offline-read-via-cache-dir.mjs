#!/usr/bin/env node
/**
 * `live.cache-dir-offline-read.test.ts` が使う、専用の計測プロセス。
 *
 * すでに warm な `cacheDir`（本物のモデル一式）だけを使い、**既定のキャッシュには一切触れず**、
 * `env.fetch` を必ず失敗させた状態で、`@mnemora/local-embedding`（**ビルド済みの dist**。
 * `createLocalEmbeddingPipeline` 経由）から読み込み、1件埋め込めるかを確かめる（Issue #1239）。
 *
 * - `env.fetch` の差し替えは、`@huggingface/transformers` を import した直後・
 *   `@mnemora/local-embedding` を import する前に行う——差し替えの後でなければ、
 *   4.2.0 が `globalThis.fetch` を束縛して既定の `env.fetch` にする前に間に合わない
 *   （`local-embedding-offline-load-check.ts` の doc と同じ注意）。
 * - `env.cacheDir`（既定のキャッシュ）には触らない——このプロセスの `.cache/`
 *   （`node_modules/@huggingface/transformers/.cache/` など）が温まっているかどうかに
 *   依存せずに測るためである。温まっていたら「cacheDir のおかげ」なのか「既定のキャッシュの
 *   おかげ」なのかが区別できなくなる。
 *
 * 使い方: node measure-offline-read-via-cache-dir.mjs <cacheDir> <repo> <dtype>
 * 標準出力へ `{ fetchCount, urls, outcome, error, vectorLen }` を1行の JSON で出す。
 */
import process from "node:process";

// `[revision]` は省略できる（Issue #1403 の live の歯が渡す）。
const [, , cacheDir, repo, dtype, revision] = process.argv;
if (!cacheDir || !repo || !dtype) {
  console.error("usage: measure-offline-read-via-cache-dir.mjs <cacheDir> <repo> <dtype>");
  process.exit(2);
}

const { env } = await import("@huggingface/transformers");
/** @type {string[]} */
const urls = [];
env.fetch = async (input) => {
  urls.push(typeof input === "string" ? input : (input?.url ?? String(input)));
  throw new TypeError("fetch failed (measure-offline-read-via-cache-dir: network is disabled)");
};

const { createLocalEmbeddingPipeline } = await import("@mnemora/local-embedding");

let outcome = "loaded";
let error = null;
let vectorLen = null;
try {
  const pipeline = await createLocalEmbeddingPipeline({
    repo,
    dtype,
    cacheDir,
    numThreads: 1,
    ...(revision !== undefined ? { revision } : {}),
  });
  const [vector] = await pipeline.embed(["オフラインで読めるかの確認"]);
  vectorLen = vector?.length ?? null;
} catch (err) {
  outcome = "failed";
  error = String(err?.message ?? err).slice(0, 500);
}

process.stdout.write(
  JSON.stringify({ fetchCount: urls.length, urls, outcome, error, vectorLen }) + "\n",
);
