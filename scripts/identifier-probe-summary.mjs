#!/usr/bin/env node
/**
 * 🔴 基準値と相違しても exit 0。これは意図した設計で、バグではない。「門にしない」と「基準値と比べない」は別のこと(ADR 0088 §3、§2.1)。
 * 非0になるのは入力そのものが壊れているときだけ(`--baseline` が読めない/壊れている場合も含む)。
 *
 * 🔴 `status: "weights_unavailable"` でも exit 0。そのとき `--baseline` を渡していても比較は1つも出さない。
 * ⛔ 「測れなかった」を「基準値と違う」に化けさせない。
 * ⚠ `identifier-probes` を実行する CI ステップ自体は、重みが取得できなければ non-zero で終わる(仕様どおり)。この exit code とは別の話。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "./identifier-probe-summary-lib.mjs";

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
    "使い方: node scripts/identifier-probe-summary.mjs --measured <path> [--baseline <path>]",
  );
  process.exit(1);
}

/**
 * 読めない/parse できない理由をそのまま返す。「壊れている」と一括りにしない。
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
// 明示的に 0 を宣言する。門ではない、という設計の要をコード上で目に見える形にする。
process.exit(0);
