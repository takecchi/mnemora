#!/usr/bin/env node
/** 判定ではない: exit code では何も判定しない（入力が読めない・壊れている場合だけ非0）。 */
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
