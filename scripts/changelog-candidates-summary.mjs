#!/usr/bin/env node
/**
 * PR ごとに「CHANGELOG 載せ漏れの候補」を PR の Job Summary(`$GITHUB_STEP_SUMMARY`)へ出す CLI。
 * [Issue #433](https://github.com/takecchi/mnemora/issues/433) 方向(B) の B2 版
 * ——判定・確定は一切せず、候補の列挙だけを行う（詳しい経緯は
 * `./changelog-candidates-summary-lib.mjs` 冒頭の doc コメントと ADR 0214 の追記を見ること）。
 *
 * ## 🔴 これは門ではない —— 終了コードは常に 0 である
 *
 * `origin/main...HEAD` の差分を読み、`packages/*\/src` を触っているのに `CHANGELOG.md` の
 * 未リリース節にこの PR が追加した行が見当たらないファイルを列挙するだけである。
 * 候補が1件でもあっても、実行時エラー（`git` の呼び出し失敗等）が起きても、**このプロセスは
 * 非0 で終わらない**——`.github/workflows/ci.yml` 側で `continue-on-error` を付ける必要はない
 * （そもそも付けてはいけない。付けると「本当は失敗しているのに握り潰した」形になり、
 * このスクリプト自身が常に0で終わるという設計と重複した二重の安全策になる）。
 *
 * 実行時エラーのときは、それを Job Summary にそのまま出し「判定していない」と明記した上で、
 * それでも exit 0 で終わる。⛔ 候補を見落とす方向の失敗のほうが、CI を赤くする方向の失敗より
 * 安全である、という判断による（この道具は required check ではないので `main` を止めない）。
 *
 * ## 使い方
 *
 * ```
 * node scripts/changelog-candidates-summary.mjs
 * ```
 *
 * `origin/main` が fetch 済みであることを前提にする（`scripts/check-pr-adr-reference.mjs` と
 * 同じ前提——`.github/workflows/ci.yml` 側で `git fetch origin main` を先に実行する）。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeChangelogCandidates,
  formatChangelogCandidatesSummary,
} from "./changelog-candidates-summary-lib.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = "origin/main";
const CHANGELOG_RELATIVE_PATH = "CHANGELOG.md";

const HEADER = "## CHANGELOG 載せ漏れの候補（⛔ 判定ではない。Issue #433 方向B2 / ADR 0214 追記）";

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: REPO_ROOT });
}

/** stdout へ出し、`$GITHUB_STEP_SUMMARY` が在れば追記する。書き込みに失敗しても落とさない。 */
function report(text) {
  console.log(text);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `${text}\n`);
    } catch (err) {
      // ⛔ 通知の書き込みに失敗しても落とさない——この道具は何も止めない側である。
      console.log(`⚠ ステップ要約へ書けなかった: ${String(err.message ?? err)}`);
    }
  }
}

function listTouchedFiles() {
  return run("git", ["diff", "--name-only", `${BASE_REF}...HEAD`])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readChangelogText() {
  const path = join(REPO_ROOT, CHANGELOG_RELATIVE_PATH);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function readChangelogDiffText(touchedFiles) {
  if (!touchedFiles.includes(CHANGELOG_RELATIVE_PATH)) return "";
  return run("git", ["diff", "--unified=0", `${BASE_REF}...HEAD`, "--", CHANGELOG_RELATIVE_PATH]);
}

function main() {
  const touchedFiles = listTouchedFiles();
  const changelogText = readChangelogText();
  const changelogDiffText = readChangelogDiffText(touchedFiles);

  const result = computeChangelogCandidates({ touchedFiles, changelogText, changelogDiffText });
  report(formatChangelogCandidatesSummary(result));
}

try {
  main();
} catch (err) {
  report(
    [
      HEADER,
      "",
      `⚠ 実行時エラーのため判定していない: ${String(err.message ?? err).split("\n")[0]}`,
      "⟹ この道具は何も止めない——見えなかった分は、人が別途 git diff を見ること。",
    ].join("\n"),
  );
}
// ⭐ 常に 0。上の doc コメントの理由による。この道具は観測口であって門ではない。
process.exit(0);
