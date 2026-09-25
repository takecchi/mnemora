#!/usr/bin/env node
/**
 * `examples/chat` の `numeral-token-probes` ベンチ(`MNEMORA_NUMERAL_TOKEN_JSON` が吐く
 * JSON)を人が読める Markdown へ変換し、CI の Job Summary(`$GITHUB_STEP_SUMMARY`)へ
 * 載せる CLI(ADR 0135、Issue #109)。
 *
 * `./identifier-probe-summary.mjs` と同じ形——組み立ては
 * `./numeral-token-probe-summary-lib.mjs` の純関数に委ねる。ここは
 *
 * 1. `--measured <path>`(必須)・`--baseline <path>`(任意)を読む
 * 2. ファイルを読んで JSON.parse する(壊れていたら理由を stderr に出して非0で終わる)
 * 3. 形を検査する(`validateMeasured`/`validateBaseline`。壊れていたら同様に非0)
 * 4. Markdown を stdout に出す
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/numeral-token-probe-summary.mjs --measured <path> [--baseline <path>]
 *
 * 🔴 **基準値ファイルと相違しても exit 0 のままである。**⛔ このスクリプトは門ではない。
 * 非0になるのは、入力そのものが壊れているときだけである
 * (`./numeral-token-probe-summary-lib.mjs` 冒頭 docstring参照)。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "./numeral-token-probe-summary-lib.mjs";

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
  console.error(
    "使い方: node scripts/numeral-token-probe-summary.mjs --measured <path> [--baseline <path>]",
  );
  process.exit(1);
}

/**
 * @param {string} path
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `${label} JSON を読めない(${path}): ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${label} JSON の parse に失敗した(${path}): ${err.message}` };
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
process.exit(0);
