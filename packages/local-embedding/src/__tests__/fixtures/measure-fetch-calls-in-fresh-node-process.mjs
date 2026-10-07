#!/usr/bin/env node
/**
 * vitest のテスト本体からではなく別プロセスで呼ぶ。同じプロセスで cold と warm の読み込みを行うと、2回目が transformers.js の in-memory メモ化（`memoizePromise`）にヒットして、「cacheDir が温かいから0回」か「同一プロセスだから0回」かを区別できない。
 * 使い方: node measure-fetch-calls-in-fresh-node-process.mjs <cacheDir> <repo> <dtype> <numThreads>
 * 標準出力へ `{ fetchCount, calls: [{ url, method, range }] }` を1行の JSON で出す。
 * 数えているのは `env.fetch` の呼び出し（hub.js の `getFile()` と `fetch_file_head()` は外部へ HTTP(S) で出るとき必ずここを通る）で、ディスクの読み出し回数ではない。
 */
import process from "node:process";

const [, , cacheDir, repo, dtype, numThreadsRaw] = process.argv;
if (!cacheDir || !repo || !dtype) {
  console.error(
    "usage: measure-fetch-calls-in-fresh-node-process.mjs <cacheDir> <repo> <dtype> <numThreads>",
  );
  process.exit(2);
}
const numThreads = Number.parseInt(numThreadsRaw ?? "1", 10);

/** @type {Array<{ url: string, method: string, range: string | null }>} */
const calls = [];

// 先に import してから `env.fetch` を差し替える（`env.fetch` は呼び出し時に読まれる可変プロパティ）。
const { pipeline, env } = await import("@huggingface/transformers");

const originalFetch = env.fetch;
env.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const headers =
    init?.headers instanceof Headers ? init.headers : new Headers(init?.headers ?? {});
  calls.push({
    url,
    method: init?.method ?? "GET",
    range: headers.get("range"),
  });
  return originalFetch(input, init);
};

const extractor = await pipeline("feature-extraction", repo, {
  dtype,
  cache_dir: cacheDir,
  session_options: { intraOpNumThreads: numThreads, interOpNumThreads: 1 },
});

// 読み込みだけでなく推論も1回行う。推論が追加のネットワーク呼び出しを起こさないかも計測の対象にする。
await extractor(["今日は雨が降っている"], { pooling: "mean", normalize: true });

process.stdout.write(JSON.stringify({ fetchCount: calls.length, calls }) + "\n");
