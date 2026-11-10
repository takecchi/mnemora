#!/usr/bin/env node
/**
 * `long-horizon` の実測値を基準値と突き合わせて Job Summary の Markdown を標準出力へ出す（`long-horizon-summary-lib.mjs`）。
 * ⛔ 基準値と違っても exit 0 のまま。門ではない。非0にするのは入力が壊れているときだけ。`--baseline` は任意。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "./long-horizon-summary-lib.mjs";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const measuredPath = valueOf("--measured");
const baselinePath = valueOf("--baseline");
if (!measuredPath) {
  console.error(
    "使い方: node scripts/long-horizon-summary.mjs --measured <path> [--baseline <path>]",
  );
  process.exit(1);
}

function readJson(path, label) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return {
      ok: false,
      error: `${label} JSON を読めない・parse できない（${path}）: ${err.message}`,
    };
  }
}

const measuredRead = readJson(measuredPath, "実測");
if (!measuredRead.ok) {
  console.error(measuredRead.error);
  process.exit(1);
}
const measured = validateMeasured(measuredRead.value);
if (!measured.ok) {
  console.error(measured.error);
  process.exit(1);
}
let baseline;
if (baselinePath) {
  const baselineRead = readJson(baselinePath, "基準値");
  if (!baselineRead.ok) {
    console.error(baselineRead.error);
    process.exit(1);
  }
  const validated = validateBaseline(baselineRead.value);
  if (!validated.ok) {
    console.error(validated.error);
    process.exit(1);
  }
  baseline = validated.value;
}
console.log(buildSummaryMarkdown({ measured: measured.value, baseline }));
