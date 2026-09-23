#!/usr/bin/env node
/**
 * `scripts/measure-embedding-output-fingerprint.mjs` が書いた測定 JSON を人が読める
 * Markdown へ変換し、CI の Job Summary（`$GITHUB_STEP_SUMMARY`）へ載せる CLI
 * （Issue #565、ADR 0253 追記）。
 *
 * 組み立てそのものは `./embedding-output-fingerprint-summary-lib.mjs` の純関数に委ねる。
 *
 * 使い方:
 *   node scripts/embedding-output-fingerprint-summary.mjs --measured <path>
 *
 * ⛔ **このスクリプトは門ではない。**非0で終わるのは、`--measured` の中身が
 * 測定結果として使えない（壊れている）ときだけである。
 */
import { readFileSync } from "node:fs";
import {
  validateFingerprintRecord,
  buildFingerprintSummaryMarkdown,
} from "./embedding-output-fingerprint-summary-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const measuredPath = readArgValue("--measured");

if (!measuredPath) {
  console.error("使い方: node scripts/embedding-output-fingerprint-summary.mjs --measured <path>");
  process.exit(1);
}

let text;
try {
  text = readFileSync(measuredPath, "utf8");
} catch (err) {
  console.error(`測定 JSON を読めない（${measuredPath}）: ${err.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch (err) {
  console.error(`測定 JSON の parse に失敗した（${measuredPath}）: ${err.message}`);
  process.exit(1);
}

const validated = validateFingerprintRecord(parsed);
if (!validated.ok) {
  console.error(validated.error);
  process.exit(1);
}

console.log(buildFingerprintSummaryMarkdown(validated.value));
process.exit(0);
