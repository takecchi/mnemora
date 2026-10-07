#!/usr/bin/env node
/**
 * ⛔ 印の付いた片が1つも見つからなければ exit 1(抜き出しが壊れて何も見ていないのに緑になる形を作らない)。
 * ⚠ `dist` を読む。`pnpm run build` の後に走らせること。
 * 片を直すときは文書を実装に合わせる。実装のほうが約束から外れているなら、片の印を外して緑にせず Issue に起票する。
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
