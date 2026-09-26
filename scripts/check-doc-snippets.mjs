#!/usr/bin/env node
/**
 * 文書の中で印（` ```ts check `）を付けたコード片が、今の公開 API で型検査に通ることを確かめる門（ADR 0345）。
 *
 * - 対象: `git ls-files '*.md'` の全文書のうち、印を付けた片だけ。**印の無い片は見ない。**
 *   抜き出し・前提の変数・解決の起点は `./check-doc-snippets-lib.mjs` の doc を見ること。
 * - 全部の片を1つの Program にまとめて1回で検査する。
 * - 1つでも落ちれば exit 1。**印の付いた片が1つも見つからなければ exit 1**
 *   （抜き出しが壊れて何も見ていないのに緑になる形を作らない）。
 * - ⚠ `dist` を読む。`pnpm run build` の後に走らせること。
 *
 * 片を直すときは、文書を実装に合わせる。実装のほうが約束から外れているなら、片を直さず
 * Issue に起票すること（片の印を外して緑にしない）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkSnippets, extractCheckedSnippets } from "./check-doc-snippets-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const mdFiles = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f.length > 0);

const snippets = mdFiles.flatMap((file) =>
  extractCheckedSnippets(readFileSync(join(repoRoot, file), "utf8")).map((s) => ({ file, ...s })),
);

if (snippets.length === 0) {
  console.error(
    "❌ 印（```ts check）の付いた片が1つも見つからなかった。抜き出しが壊れているか、印が全部外れている。",
  );
  process.exit(1);
}

const started = Date.now();
const results = checkSnippets({ repoRoot, snippets });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const failed = results.filter((r) => r.diagnostics.length > 0);
for (const r of results) {
  if (r.diagnostics.length === 0) {
    console.log(`✅ ${r.file}:${r.line}`);
    continue;
  }
  console.log(`❌ ${r.file}:${r.line}`);
  for (const d of r.diagnostics) {
    console.log(`   ${r.file}:${d.line} TS${d.code}: ${d.message.replace(/\n/g, "\n     ")}`);
  }
}
console.log(
  `\n印の付いた片 ${results.length} 件（${new Set(results.map((r) => r.file)).size} 文書）を検査した。` +
    `落ちた片 ${failed.length} 件。${elapsed} 秒。`,
);
process.exit(failed.length > 0 ? 1 : 0);
