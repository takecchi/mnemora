#!/usr/bin/env node
/**
 * ADR を追加する PR の側で実行して索引も一緒にコミットする（ADR 0137・0192 末尾の 2026-09-30 の追記）。
 * ⚠ 「マージした直後に `main` 上で実行する」ではない。squash コミット自体が索引の陳腐化した状態で
 * `main` に着地し、push で毎回走る CI を赤くする。マージ前に PR ブランチ上で実行すること。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAdrEntries,
  buildIndexTable,
  spliceGeneratedIndex,
} from "./generate-adr-index-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const decisionsDir = join(__dirname, "..", "docs", "decisions");
const readmePath = join(decisionsDir, "README.md");

function loadAdrFiles() {
  return readdirSync(decisionsDir)
    .filter((filename) => filename !== "README.md")
    .map((filename) => ({
      filename,
      content: readFileSync(join(decisionsDir, filename), "utf8"),
    }));
}

function main() {
  const checkOnly = process.argv.includes("--check");

  const entries = buildAdrEntries(loadAdrFiles());
  const table = buildIndexTable(entries);
  const currentText = readFileSync(readmePath, "utf8");
  const updatedText = spliceGeneratedIndex(currentText, table);

  if (updatedText === currentText) {
    console.log(`docs/decisions/README.md は最新です（ADR ${entries.length} 本）。`);
    process.exit(0);
  }

  if (checkOnly) {
    console.error("docs/decisions/README.md が docs/decisions/*.md と一致していません。");
    console.error(`  ADR は ${entries.length} 本ありますが、索引がまだそれを反映していません。`);
    console.error("  `node scripts/generate-adr-index.mjs` を実行し、差分をコミットしてください。");
    process.exit(1);
  }

  writeFileSync(readmePath, updatedText, "utf8");
  console.log(`docs/decisions/README.md を更新しました（ADR ${entries.length} 本）。`);
}

main();
