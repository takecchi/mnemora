#!/usr/bin/env node
/**
 * Issue #1239 の歯（`cache-dir-preflight-default-cache.test.ts`）が使う、専用の計測プロセス。
 *
 * `@huggingface/transformers` の `pipeline()` に `cache_dir` を渡して（`../../pipeline.ts` の
 * `createLocalEmbeddingPipeline` が `spec.cacheDir` を `cache_dir` として渡すのと同じ形）読み込ませ、
 * そのとき外へ出ようとした要求を数える。
 *
 * - `env.cacheDir`（transformers.js の既定のキャッシュ）を、引数の `<defaultCacheDir>` に向ける——
 *   テストが既定のキャッシュを空にしたり、2ファイルを置いたりできるようにするため。本物の既定の置き場
 *   （パッケージの中の `.cache/`）には触らない。
 * - `env.fetch` は、呼ばれたら記録して必ず失敗する（ネットワークに出ない）。
 * - 読み込みそのものの成否は `outcome` に出すだけで、この歯の主張ではない（テストは偽のモデルの
 *   ファイルを置くので、ネットワークに出なくても、ファイルを解釈する段で失敗しうる）。
 *
 * ⚠ なぜ別プロセスか: transformers.js はファイルのメタデータの問い合わせをプロセスの中で
 * メモ化する（`measure-fetch-calls-in-fresh-node-process.mjs` の doc と同じ理由）。
 *
 * 使い方: node probe-preflight-default-cache.mjs <defaultCacheDir> <cacheDir> <repo> <dtype>
 * 標準出力へ `{ fetchCount, urls, outcome, error }` を1行の JSON で出す。
 */
import process from "node:process";

const [, , defaultCacheDir, cacheDir, repo, dtype] = process.argv;
if (!defaultCacheDir || !cacheDir || !repo || !dtype) {
  console.error(
    "usage: probe-preflight-default-cache.mjs <defaultCacheDir> <cacheDir> <repo> <dtype>",
  );
  process.exit(2);
}

const { pipeline, env } = await import("@huggingface/transformers");

env.cacheDir = defaultCacheDir;
/** @type {string[]} */
const urls = [];
env.fetch = async (input) => {
  urls.push(typeof input === "string" ? input : (input?.url ?? String(input)));
  throw new TypeError("fetch failed (probe-preflight-default-cache: network is disabled)");
};

let outcome = "loaded";
let error = null;
try {
  await pipeline("feature-extraction", repo, {
    dtype,
    cache_dir: cacheDir,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
} catch (err) {
  outcome = "failed";
  error = String(err?.message ?? err).slice(0, 300);
}

process.stdout.write(JSON.stringify({ fetchCount: urls.length, urls, outcome, error }) + "\n");
