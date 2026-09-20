#!/usr/bin/env node
/**
 * **`npm publish` の前に「出す版の節が `CHANGELOG.md` に在るか」を確かめる門。**
 *
 * ## 🔴 これは門である —— 節が無ければ非 0 で落ちる
 *
 * ⚠ **同じ名前で始まる `check-release-changelog-section.mjs` は門ではない**（終了コードが常に 0 の
 * 通知。[ADR 0251](../docs/decisions/0251-release-follow-up-notice-not-a-gate.md)）。
 * ⛔ **取り違えないこと。**⭐ **述語は同じもの**を使い回している（`release-changelog-gate-lib.mjs` の
 * docstring）——違うのは**終了コードと、走る場所**だけである。
 *
 * ## ⭐ なぜ `main` の required ではなく、ここなのか
 *
 * **止まるのがリリースを打った人だけだからである。**`main` の required に置くと、
 * tag を公開してから節が入るまで**無関係な PR まで赤くなる**（ADR 0251 が「先に解け」と
 * 名指しした窓）。⟹ **置き場所でそれを解いている。**
 *
 * ## 🔴 `CHANGELOG.md` の出所は、必ず明示的に渡すこと
 *
 * **既定値を持たない。**`--changelog-file` を省くと落ちる。
 * ⛔ **理由**: この門が見るべきなのは **`origin/main` の `CHANGELOG.md`** であり、
 * **checkout された tag の木のものではない**（tag の木には節がまだ無いのが正常な瞬間が在る）。
 * ⟹ **既定を「作業木の CHANGELOG.md」にすると、黙って間違った木を見る。**
 * **黙って間違えるくらいなら落ちるほうを選ぶ。**
 *
 * ## 使い方
 *
 * ```
 * git fetch origin main
 * git show origin/main:CHANGELOG.md > "$RUNNER_TEMP/changelog-main.md"
 * node scripts/check-release-changelog-section-gate.mjs \
 *   --tag v1.0.0 --changelog-file "$RUNNER_TEMP/changelog-main.md"
 * ```
 *
 * 引数を省いたときの env の対応: `--tag` → `RELEASE_TAG`、`--event-name` → `GITHUB_EVENT_NAME`、
 * `--prerelease` → `RELEASE_PRERELEASE`。
 *
 * ⛔ **判定はこのファイルに書かない**——`release-changelog-gate-lib.mjs` の純関数が持ち、歯がそれを直接測る
 * （`scripts/release-version.mjs` と同じ形）。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { decideReleaseChangelogGate } from "./release-changelog-gate-lib.mjs";

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tag") args.tag = argv[++i];
    else if (a === "--changelog-file") args.changelogFile = argv[++i];
    else if (a === "--event-name") args.eventName = argv[++i];
    else if (a === "--prerelease") args.prerelease = argv[++i];
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function report(lines) {
  const text = lines.join("\n");
  console.log(text);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${text}\n`);
  } catch (err) {
    // ⚠ 要約へ書けなくても、判定そのものは標準出力に出ている。
    // ⛔ ここで終了コードを変えない——書き込みの失敗は、節の有無とは別の話である。
    console.log(`⚠ ステップ要約へ書けなかった: ${String(err.message ?? err)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const eventName = args.eventName ?? process.env.GITHUB_EVENT_NAME ?? "";
const tagName = args.tag ?? process.env.RELEASE_TAG ?? "";
const prereleaseRaw = args.prerelease ?? process.env.RELEASE_PRERELEASE ?? "";

const header = "## 出す版の節が `CHANGELOG.md` に在るか（🔴 門である。無ければ npm へ出さない）";

// ⛔ `--changelog-file` の既定値は作らない（上の docstring の理由）。
// ⚠ ただし「この門が当たらない場面」では、そもそもファイルを要求しない
// ——予行（workflow_dispatch）に CHANGELOG の出所を渡させるのは筋が通らない。
let changelogText = "";
let changelogSource = args.changelogFile ?? "(渡されていない)";
let readError = null;
if (args.changelogFile) {
  try {
    changelogText = readFileSync(args.changelogFile, "utf8");
  } catch (err) {
    readError = String(err.message ?? err);
  }
}

const verdict = decideReleaseChangelogGate({
  eventName,
  prereleaseRaw,
  tagName,
  changelogText,
  changelogSource,
});

report([
  header,
  "",
  `- 引き金: \`${eventName || "(渡されていない)"}\``,
  `- tag: \`${tagName || "(渡されていない)"}\``,
  `- \`CHANGELOG.md\` の出所: \`${changelogSource}\``,
  ...(readError === null ? [] : [`- ⚠ 読み取りの誤り: ${readError}`]),
  "",
  ...verdict.lines,
]);

if (verdict.exitCode !== 0) {
  console.error(
    `::error::出す版（${verdict.version || "版が導けない"}）の節が CHANGELOG.md に在りません。` +
      "main へ節を入れてから、この run を再実行してください。",
  );
}

process.exit(verdict.exitCode);
