#!/usr/bin/env node
/**
 * ⛔ 値の良し悪しは門ではない。`server_encoding`/`nonAsciiIsIndexed` がどちらの値でも、それ自体では非0にならない
 * (基準値ファイルも置いていない。理由は `lexical-regime-summary-lib.mjs` の docstring)。
 *
 * 🔴 非0で終わる経路は4つあり、意図して別々のメッセージにしている。ファイルが無い(`ENOENT`。測定段自体が
 * 落ちていないか先に見る)・JSON が壊れている・`validateMeasured` が拒否・宣言と実測の食い違い。
 * 「歯が書く呼び出しごと消えた」のか「書いたが中身が壊れている」のかを、stderr だけで見分けるため。
 * 1〜3は regime の値を見ない。4は「一致したか」だけを見て、どちらの値が正しいかは判定しない。
 *
 * ⭐ 順序が重要。`validateMeasured` を通ったら、先に Markdown を stdout へ出し、そのあとで
 * `compareDeclaredEncoding` を見て不一致なら exit 1 する。赤くなるときこそ値が Job Summary に残らないと
 * 意味がないので、先に判定して早期 return しない。
 */
import { readFileSync } from "node:fs";
import {
  validateMeasured,
  buildSummaryMarkdown,
  compareDeclaredEncoding,
} from "./lexical-regime-summary-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const measuredPath = readArgValue("--measured");
const expectEncoding = readArgValue("--expect-encoding");

if (!measuredPath || !expectEncoding) {
  console.error(
    "使い方: node scripts/lexical-regime-summary.mjs --measured <path> " +
      "--expect-encoding <value>",
  );
  process.exit(1);
}

let text;
try {
  text = readFileSync(measuredPath, "utf8");
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(
      `regime JSON が出ていない(${measuredPath} が存在しない)。` +
        "packages/postgres の lexical-store-identifier.test.ts が " +
        "MNEMORA_LEXICAL_REGIME_JSON へ書く前に落ちたか、その呼び出しごと消えた可能性がある" +
        "——測定段(test:db)自体が落ちていないか先に見ること。",
    );
  } else {
    console.error(`regime JSON を読めない(${measuredPath}): ${err.message}`);
  }
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch (err) {
  console.error(`regime JSON の parse に失敗した(${measuredPath}): ${err.message}`);
  process.exit(1);
}

const validated = validateMeasured(parsed);
if (!validated.ok) {
  console.error(validated.error);
  process.exit(1);
}

console.log(buildSummaryMarkdown(validated.value, expectEncoding));

const comparison = compareDeclaredEncoding(validated.value, expectEncoding);
if (!comparison.ok) {
  console.error(comparison.error);
  process.exit(1);
}

// 明示的に 0 を宣言する。宣言と実測が一致している限り、regime の値がどちらでも門にしない。
process.exit(0);
