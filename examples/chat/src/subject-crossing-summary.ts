#!/usr/bin/env node
/**
 * `subject-crossing-cost` ベンチ(`subject-crossing-measure.ts`)の raw JSON
 * (`{ commit, measuredAt, results }`)を Markdown へ変換する CLI(Issue #579)。
 *
 * 組み立ては `./subject-crossing-summary-lib.ts` の純関数に委ねる
 * (`consolidation-cost-summary.mjs`/`consolidation-cost-summary-lib.mjs` と同じ分担)。
 * ここは
 *
 * 1. `<raw.json> <out.md>` の2引数を読む
 * 2. ファイルを読んで JSON.parse する(壊れていたら理由を stderr に出して非0で終わる)
 * 3. Markdown を書き出す
 *
 * だけを行う。
 *
 * 使い方:
 *   tsx src/subject-crossing-summary.ts <raw.json> <out.md>
 *
 * ⛔ **これは判定ではない。** `subject-crossing-measure.ts` の docstring と同じ規律——
 * 集計に「正しい値」は無いので、このスクリプトは exit code で何かを判定しない
 * (入力そのものが読めない・壊れている場合だけ非0)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  parseRawFile,
  renderMarkdownReport,
  summarizeTrials,
} from "./subject-crossing-summary-lib.js";

const [inputPath, outPath] = process.argv.slice(2);
if (inputPath === undefined || outPath === undefined) {
  console.error("usage: tsx src/subject-crossing-summary.ts <raw.json> <out.md>");
  process.exit(1);
}

let text: string;
try {
  text = readFileSync(inputPath, "utf8");
} catch (error) {
  console.error(
    `${inputPath} を読めない: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const parsed = parseRawFile(text);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}

const rows = summarizeTrials(parsed.value.results);
const header =
  `<!-- commit=${parsed.value.commit ?? "unknown"} measuredAt=${parsed.value.measuredAt} ` +
  `trials=${parsed.value.results.length} -->\n\n`;
writeFileSync(outPath, header + renderMarkdownReport(rows));
console.log(`wrote ${outPath} (${rows.length} rows from ${parsed.value.results.length} trials)`);
process.exit(0);
