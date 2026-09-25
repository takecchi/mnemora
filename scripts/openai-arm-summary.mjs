#!/usr/bin/env node
/**
 * `examples/chat` の `identifier-probes`/`numeral-token-probes` サブコマンドが
 * **追加で**書き出す OpenAI 実埋め込み(`recorded` provider 再生)の JSON を
 * 人が読める Markdown へ変換し、CI の Job Summary(`$GITHUB_STEP_SUMMARY`)へ
 * 載せる CLI(Issue #109 後半)。
 *
 * 組み立ては `./openai-arm-summary-lib.mjs` の純関数に委ねる
 * (`identifier-probe-summary.mjs`/`-lib.mjs` と同じ分担)。
 *
 * 使い方:
 *   node scripts/openai-arm-summary.mjs --title <title> --measured <path> [--baseline <path>]
 *
 * 🔴 **`--measured` のファイルが無くても exit 0 のままである。**
 * `examples/chat/src/cli.ts` の openai arm ブロックは、例外を握って local embedding
 * 測定・ジョブ自体を落とさない設計であり(そのブロック自身の doc コメント参照)、
 * その結果 JSON が1件も書かれないことがある——**「measure しようとしたが失敗した」を
 * 「入力が壊れている」と同じ顔で落とさない**(`identifier-probe-summary.mjs` の
 * `weights_unavailable` と同じ形の区別)。
 *
 * ⛔ **相違しても exit 0 のまま。**非0になるのは、**在るファイルが壊れている**とき
 * (JSON が parse できない・`status` が未知・必須項目が無い)だけである。
 */
import { existsSync, readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "./openai-arm-summary-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const title = readArgValue("--title");
const measuredPath = readArgValue("--measured");
const baselinePath = readArgValue("--baseline");

if (!title || !measuredPath) {
  console.error(
    "使い方: node scripts/openai-arm-summary.mjs --title <title> --measured <path> [--baseline <path>]",
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
    return { ok: false, error: `${label} JSON を読めない（${path}）: ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${label} JSON の parse に失敗した（${path}）: ${err.message}` };
  }
}

if (!existsSync(measuredPath)) {
  console.log(
    `# ${title}(Issue #109 後半——OpenAI 実埋め込み)\n\n` +
      `🔴 実測 JSON が無い（${measuredPath}）。openai arm の測定が走らなかった、` +
      "または失敗した(⛔ 上位の local embedding 測定・このジョブ自体は落とさない設計であり、" +
      "この空白自体はジョブを落とす理由にしない)。",
  );
  process.exit(0);
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
    title,
    measured: measuredValidated.value,
    ...(baselineValidated ? { baseline: baselineValidated.value } : {}),
  }),
);
process.exit(0);
