#!/usr/bin/env node
/**
 * `@mnemora/local-embedding` が読み込む transformers.js の**既定のキャッシュの場所**（`env.cacheDir`）と、その版を、
 * `$GITHUB_OUTPUT` の行形式（`dir=…`・`version=…`）で印字する（Issue #1004）。
 *
 * 🔴 **なぜ要るか。** transformers.js（4.2.0）の `pipeline()` は、読み込みの前に `get_pipeline_files()` を呼び、
 * `config.json`・`tokenizer_config.json` の有無を確かめる。この確認は `cache_dir` を受け取らず、**既定のキャッシュ
 * だけを見る**——`LocalEmbeddingProvider` に `cacheDir` を渡していても、既定のキャッシュが空なら Hugging Face へ
 * 取りに行く。⟹ CI は、この場所もキャッシュとして復元・保存する。
 *
 * ⚠ 場所は transformers.js の版で変わる（pnpm の `node_modules/.pnpm/@huggingface+transformers@<版>/…/.cache/`）。
 * ⟹ 書き写さずに、`packages/local-embedding` から実際に読み込んで `env.cacheDir` を読む。
 *
 * `--plain` を渡すと、`dir` の値だけを印字する。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromLocalEmbedding = createRequire(
  join(repoRoot, "packages/local-embedding/package.json"),
);
function transformersPackageRoot(requireFrom) {
  // exports に ./package.json が無いので、入口を解決してから package.json まで上る。
  let dir = dirname(requireFrom.resolve("@huggingface/transformers"));
  while (
    !existsSync(join(dir, "package.json")) ||
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "@huggingface/transformers"
  ) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("@huggingface/transformers の package.json が見つからない");
    dir = parent;
  }
  return dir;
}
const pkgJsonPath = join(transformersPackageRoot(requireFromLocalEmbedding), "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const esmEntry = pkg.exports?.node?.import?.default;
if (typeof esmEntry !== "string") {
  console.error(
    "print-transformers-default-cache-dir: @huggingface/transformers の exports.node.import.default が読めない",
  );
  process.exit(1);
}
const { env } = await import(pathToFileURL(join(dirname(pkgJsonPath), esmEntry)).href);
if (typeof env.cacheDir !== "string" || env.cacheDir === "") {
  console.error(
    "print-transformers-default-cache-dir: env.cacheDir が文字列ではない（既定のファイルキャッシュが無い構成）",
  );
  process.exit(1);
}
if (process.argv.includes("--plain")) {
  console.log(env.cacheDir);
} else {
  console.log(`dir=${env.cacheDir}`);
  console.log(`version=${pkg.version}`);
}
