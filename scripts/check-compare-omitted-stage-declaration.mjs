#!/usr/bin/env node
/**
 * 「`compare` の `omitted` の `stage` 集合が基準値から動いたら、その PR に *申告* を
 * 要求する」門の CLI 入口（Issue #403）。
 *
 * 判定そのものは `scripts/compare-omitted-stage-declaration-lib.mjs` の純関数が持つ
 * ——この入口はファイルと環境変数を読み、結果を人が読める形で出し、終了コードを決めるだけである。
 *
 * ## 使い方
 *
 * ```
 * node scripts/check-compare-omitted-stage-declaration.mjs \
 *   --measured <compare.json> --baseline examples/chat/compare-baseline.json
 * ```
 *
 * PR 本文は環境変数 `PR_BODY` から読む（`ci.yml` が
 * `${{ github.event.pull_request.body }}` を渡す）。**`PR_BODY` が無ければ判定しない**
 * ——`main` への push には PR 本文が無いためである。
 *
 * ## 終了コード
 *
 * - `0` — 動いていない / 申告が在る / 判定しない（PR 本文が無い）
 * - `1` — 🔴 動いたのに申告が無い
 * - `2` — 判定不能（実測と基準値の `turnCount` 集合が食い違う）
 */
import { readFileSync } from "node:fs";
import { evaluate, exitCodeFor } from "./compare-omitted-stage-declaration-lib.mjs";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

function readRows(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`✗ ${label} (${path}) を読めませんでした: ${error.message}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed?.rows)) {
    console.error(`✗ ${label} (${path}) に配列の \`rows\` が在りません。`);
    process.exit(2);
  }
  return parsed.rows;
}

const measuredPath = argValue("--measured");
const baselinePath = argValue("--baseline");
if (measuredPath === null || baselinePath === null) {
  console.error("✗ --measured と --baseline の両方が要ります。");
  process.exit(2);
}

const result = evaluate({
  measuredRows: readRows(measuredPath, "実測"),
  baselineRows: readRows(baselinePath, "基準値"),
  prBody: process.env.PR_BODY,
});

if (result.status === "skipped") {
  console.log(
    "⊘ PR 本文が無いので判定していません（`PR_BODY` が未設定）。⛔ 「動いていない」ではありません。",
  );
} else if (result.status === "unmeasurable") {
  console.error(
    "✗ 判定不能: 実測と基準値の turnCount 集合が一致しません。\n" +
      `  実測:   [${result.mismatch.measured.join(", ")}]\n` +
      `  基準値: [${result.mismatch.baseline.join(", ")}]\n` +
      "  ⛔ 「比較していない」を「動いていない」と同じ顔にしないため、非0で終わります。",
  );
} else if (result.status === "no_change") {
  console.log("✔ `omitted` の stage 集合は基準値から動いていません。");
} else {
  const lines = result.changed.map(
    (row) =>
      `    turn=${row.turnCount}  基準値{${row.baseline.join(", ")}} → 実測{${row.measured.join(", ")}}`,
  );
  if (result.status === "declared") {
    console.log(
      "✔ `omitted` の stage 集合が動いていますが、PR 本文に申告が在ります。\n" +
        `  申告: ${result.declaration.raw}\n` +
        `  動いた行（${result.changed.length}件）:\n${lines.join("\n")}\n` +
        "  ⛔ この門は申告の中身が正しいかを見ていません。",
    );
  } else {
    console.error(
      "✗ `omitted` の stage 集合が基準値から動いていますが、PR 本文に申告が在りません。\n" +
        `  動いた行（${result.changed.length}件）:\n${lines.join("\n")}\n` +
        "\n" +
        "  直し方: PR 本文に次の形の行を1本足すこと（理由まで書くこと。印だけでは通りません）:\n" +
        "\n" +
        "    Compare-Omitted-Stage: <なぜ動いたのか。意図した仕様変更なら、その出所（ADR 番号など）>\n" +
        "\n" +
        "  ⚠ この門が見るのは、この CI 実行を起こした push の時点の PR 本文だけである。\n" +
        "     ⟹ 申告を書いてから push し、緑を引き直すこと（`gh pr edit` を後から打っても効かない）。\n" +
        "  ⛔ 基準値 `examples/chat/compare-baseline.json` を、この門を黙らせるためだけに更新しないこと。\n" +
        "     基準値の更新は CI artifact からのみ行う（ADR 0121 / ADR 0231）。",
    );
  }
}

process.exit(exitCodeFor(result.status));
