#!/usr/bin/env node
/**
 * `docs/decisions/README.md` の索引テーブルを `docs/decisions/*.md` から生成する
 * （Issue #230 案A、ADR 0137）。純関数側は `scripts/generate-adr-index-lib.mjs`。
 *
 * 使い方:
 *   node scripts/generate-adr-index.mjs          # 生成して書き込む（変更が無ければ何もしない）
 *   node scripts/generate-adr-index.mjs --check  # 書き込まず、最新かどうかだけを判定する
 *                                                 # （終了コード 0=最新 / 1=陳腐化）
 *
 * **ADR を追加する PR の側で、このスクリプトを実行して索引も一緒にコミットする。**
 * `adr-index-freshness` の歯を PR 上で緑にしてからマージする。ほかの ADR の PR と
 * 索引の行が衝突したら、`main` を merge で取り込み、このスクリプトで作り直す
 * （ADR 0137「決定」2番は「作成者は触らない」と読めるが、実際の運用はこちら。
 * 同 ADR と ADR 0192 の末尾の 2026-09-30 の追記を見ること）。
 *
 * ⚠ **「マージした直後に `main` 上で実行する」ではない。** そうすると
 * squash コミット自体が索引の陳腐化した状態のまま `main` に着地し、
 * `main` への push で毎回走る CI（`ci.yml`）を赤くする。マージ**前**に
 * PR ブランチ上で実行することで、`main` に着地する squash コミットは
 * 最初から索引が最新の状態を含む（ADR 0137「決定」2番）。
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
