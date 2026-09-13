#!/usr/bin/env node
/**
 * Issue #164 の「実ふるまいの歯」が使う、専用の計測プロセス。
 *
 * ⚠ **なぜ vitest のテスト本体からではなく、別プロセスとして呼ぶか。**
 * transformers.js は `@huggingface/transformers` の `env`（ファイルメタデータの
 * 問い合わせを `memoizePromise` でプロセス内メモ化する）を持つ。同じ vitest プロセスの
 * 中で「1回目の読み込み（cold）」と「2回目の読み込み（warm のつもり）」を両方行うと、
 * 2回目がディスクキャッシュではなく**この in-memory メモ化**にヒットしてしまい、
 * 「cacheDir が温かいから0回」なのか「同一プロセス内だから0回」なのかを区別できない。
 *
 * ⟹ CI の実際の形（cache 復元 → 新しい vitest プロセスが1回だけ読み込む）に合わせて、
 * **「温める」は呼び出し側（親プロセス）、「測る」は毎回まっさらな子プロセス**に分けた。
 *
 * 使い方: node measure-fetch-calls-in-fresh-node-process.mjs <cacheDir> <repo> <dtype> <numThreads>
 * 標準出力へ `{ fetchCount, calls: [{ url, method, range }] }` を1行の JSON で出す。
 *
 * **何を数えているか（歯のコメントにも明記する契約と同じもの）**:
 * `@huggingface/transformers` の `env.fetch` — hub.js の `getFile()` と
 * `get_file_metadata.js` の `fetch_file_head()` は、実際に外部へ HTTP(S) で出るとき
 * **必ずこの関数を通る**（ローカルファイルの読み出しは `node:fs` を直接使い、
 * ここには現れない）。⟹ ここで数えている回数は「ディスクの読み出し回数」ではなく
 * 「Hugging Face（または任意の remoteHost）へ実際に飛んだ HTTP(S) リクエストの回数」である。
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

// `pipeline.ts` と同じく、まず import してから `env.fetch` を差し替える
// （`env.fetch` は呼び出し時に読まれる可変プロパティであり、import 時点で固定された
// 値ではない——差し替えのタイミングを気にしなくてよい）。
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

// 読み込みだけでなく、実際に1回推論もする——「推論そのものが追加のネットワーク呼び出しを
// 起こさないか」も、この計測の対象に含める。
await extractor(["今日は雨が降っている"], { pooling: "mean", normalize: true });

process.stdout.write(JSON.stringify({ fetchCount: calls.length, calls }) + "\n");
