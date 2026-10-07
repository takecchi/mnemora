#!/usr/bin/env node
/**
 * workflow 側は `${{ }}` の直接展開ではなく `env:` 経由で `EVENT_NAME` / `DRY_RUN_INPUT` を渡す。
 * 利用者が渡す `dry_run` の shell への注入面を減らすため。
 */
import { appendFileSync } from "node:fs";
import { decideDryRun } from "./publish-dry-run.mjs";

const eventName = process.env.EVENT_NAME ?? "";
const dryRunInput = process.env.DRY_RUN_INPUT;

const { dryRun, warnings } = decideDryRun({ eventName, dryRunInput });

for (const warning of warnings) {
  console.log(`::warning::${warning}`);
}

const outputLine = `dry_run=${dryRun}\n`;
const outputPath = process.env.GITHUB_OUTPUT;
if (outputPath) {
  appendFileSync(outputPath, outputLine);
} else {
  // `$GITHUB_OUTPUT` が無い環境(手元実行)でも、決まった値が見えなくなるのを避ける。
  console.log(`(GITHUB_OUTPUT 未設定のため標準出力へ) ${outputLine.trim()}`);
}

console.log(dryRun ? "判定: 予行（--dry-run）" : "判定: 本番 publish");
