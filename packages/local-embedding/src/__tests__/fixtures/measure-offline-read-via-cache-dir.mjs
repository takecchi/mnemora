#!/usr/bin/env node
/**
 * `env.fetch` の差し替えは、`@huggingface/transformers` を import した直後・`@mnemora/local-embedding` を import する前に行う（4.2.0 が `globalThis.fetch` を束縛して既定の `env.fetch` にする前に間に合わせるため）。
 * `env.cacheDir`（既定のキャッシュ）には触らない。温まっていると「cacheDir のおかげ」か「既定のキャッシュのおかげ」かが区別できなくなる。
 * 使い方: node measure-offline-read-via-cache-dir.mjs <cacheDir> <repo> <dtype>
 * 標準出力へ `{ fetchCount, urls, outcome, error, vectorLen }` を1行の JSON で出す。
 */
import process from "node:process";

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
