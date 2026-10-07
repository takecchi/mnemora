#!/usr/bin/env node
/**
 * ⛔ 基準値と相違しても exit 0 のまま。門ではない(ADR 0088 §2)。
 * 非0にするのは入力が壊れているときだけ。`--baseline` は任意。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "./time-term-summary-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const measuredPath = readArgValue("--measured");
const baselinePath = readArgValue("--baseline");

if (!measuredPath) {
  console.error("使い方: node scripts/time-term-summary.mjs --measured <path> [--baseline <path>]");
  process.exit(1);
}

/**
 * 読めない・parse できない理由をそのまま返す。「壊れている」と一括りにしない。
 *
 * @param {string} path
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `${label} JSON を読めない（${path}）: ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${label} JSON の parse に失敗した（${path}）: ${err.message}` };
  }
}

const measuredRead = readJson(measuredPath, "実測");
if (!measuredRead.ok) {
  console.error(measuredRead.error);
  process.exit(1);
}
const measuredValidated = validateMeasured(measuredRead.value);
if (!measuredValidated.ok) {
  console.error(measuredValidated.error);
  process.exit(1);
}

let baselineValidated;
if (baselinePath) {
  const baselineRead = readJson(baselinePath, "基準値");
  if (!baselineRead.ok) {
    console.error(baselineRead.error);
    process.exit(1);
  }
  baselineValidated = validateBaseline(baselineRead.value);
  if (!baselineValidated.ok) {
    console.error(baselineValidated.error);
    process.exit(1);
  }
}

console.log(
  buildSummaryMarkdown({
    measured: measuredValidated.value,
    ...(baselineValidated ? { baseline: baselineValidated.value } : {}),
  }),
);
// 門ではない: ここまで来たら入力は壊れていないので、相違があっても 0 を明示する。
process.exit(0);
