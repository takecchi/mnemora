#!/usr/bin/env node
/**
 * ⛔ `compare` は他5本と違い、門である(ADR 0133)。終了コード: 0 = pass、1 = fail(悪化・退行、または入力が壊れている)、2 = 判定不能。
 * ⛔ 判定不能を pass に倒さない。実測と基準値の `turnCount` 集合が一致しないのは「比較していない」であって「退行が無い」ではない。
 *
 * `--baseline` を渡さない場合は exit 0(基準値が無ければ悪化の判定そのものができない)。
 *
 * 🔴 `--baseline`・`--measured` を渡していて値が空・無い・次のフラグなら、使い方の誤りとして exit 1。「渡さない」と同じ扱いにしない。
 * `--baseline "$BASELINE"` の展開が空になると、門が黙って外れるため。
 *
 * ⚠ 門が見ない欄(`omitted` 等)が基準値と相違しているときは、stderr へ基準値の鮮度の警告を出す(`evaluateBaselineFreshness`)。
 * これは門ではなく、終了コードは変えない。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  evaluateBaselineFreshness,
  evaluateCompare,
  validateBaseline,
  validateMeasured,
} from "./compare-summary-lib.mjs";

const args = process.argv.slice(2);
const usage = "使い方: node scripts/compare-summary.mjs --measured <path> [--baseline <path>]";

/**
 * フラグが在るのに値が空・無い・次のフラグなら exit 1。「指定した」を「指定していない」と同じ顔で通さない。
 *
 * @param {string} flag
 * @returns {string | undefined}
 */
function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    console.error(`${flag} にパスが渡っていない（空・値なし・次のフラグ）。\n${usage}`);
    process.exit(1);
  }
  return value;
}

const measuredPath = readArgValue("--measured");
const baselinePath = readArgValue("--baseline");

if (measuredPath === undefined) {
  console.error(usage);
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

if (baselineValidated) {
  const evaluation = evaluateCompare(measuredValidated.value, baselineValidated.value);

  // ⚠ 鮮度の警告は、fail / indeterminate で早期 exit する前に必ず一度は出す。配置をここより下へ動かさないこと。
  const freshness = evaluateBaselineFreshness(measuredValidated.value, baselineValidated.value);
  if (freshness.isStale) {
    console.error(
      `[compare-summary] ⚠ 基準値の鮮度: turnCount=` +
        `${freshness.staleRows.map((row) => row.turnCount).join(", ")} で` +
        `⭐門が見ない欄(${freshness.staleFieldNames.join(", ")})が基準値と相違している。` +
        "⛔ これは門ではない(終了コードは変えない)。",
    );
  }

  if (evaluation.verdict === "indeterminate") {
    // ⛔ 判定不能を pass に倒さない。
    console.error("[compare-summary] 判定不能: 比較していない会話長が在る(Issue #477)。");
    console.error(`[compare-summary] 理由: ${evaluation.reason}`);
    console.error(
      `[compare-summary] 比較した会話長: ${evaluation.comparedTurnCounts.length} 件` +
        (evaluation.comparedTurnCounts.length > 0
          ? `(turnCount=${evaluation.comparedTurnCounts.join(", ")})`
          : ""),
    );
    if (evaluation.measuredOnlyTurnCounts.length > 0) {
      console.error(
        `[compare-summary] 🔴 比較していない会話長(実測に在って基準値に無い) ${evaluation.measuredOnlyTurnCounts.length} 件: ` +
          `turnCount=${evaluation.measuredOnlyTurnCounts.join(", ")}`,
      );
    }
    if (evaluation.baselineOnlyTurnCounts.length > 0) {
      console.error(
        `[compare-summary] 🔴 比較していない会話長(基準値に在って実測に無い) ${evaluation.baselineOnlyTurnCounts.length} 件: ` +
          `turnCount=${evaluation.baselineOnlyTurnCounts.join(", ")}`,
      );
    }
    for (const regression of evaluation.regressions) {
      console.error(
        `[compare-summary] ⚠ 比較できた範囲での退行 turnCount=${regression.turnCount}: ${regression.reasons.join(" / ")}`,
      );
    }
    process.exit(2);
  }

  if (evaluation.verdict === "fail") {
    console.error(
      `[compare-summary] ⭐ 北極星の物差しが ${evaluation.regressions.length} 会話長で退行した(ADR 0133 により門):`,
    );
    for (const regression of evaluation.regressions) {
      console.error(`  - turnCount=${regression.turnCount}: ${regression.reasons.join(" / ")}`);
    }
    process.exit(1);
  }
}

// 明示的に 0 を宣言する。
process.exit(0);
