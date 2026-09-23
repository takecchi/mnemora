#!/usr/bin/env node
/**
 * リリースを publish した後に、**出した版の節が `CHANGELOG.md` に在るか**を通知する道具。
 *
 * ## 🔴 これは門ではない —— 終了コードは常に 0 である
 *
 * **失敗しても何も止めない。**required status check にも載せない。
 * ⟹ **誤報しても、誰の PR も止まらない。**外すときも、この道具とワークフロー1本を消すだけである。
 * ⭐ **この性質が、採らなかった案（`main` の required で強制する形）との唯一の線である**
 * ——理由は [ADR 0251](../docs/decisions/0251-release-follow-up-notice-not-a-gate.md)。
 * ⛔ **だから、ここを非 0 で落とす形へ変えないこと。**変えた瞬間に、却下した案へ移る。
 *
 * ## 使い方
 *
 * ```
 * node scripts/check-release-changelog-section.mjs <tag 名>
 * ```
 *
 * `<tag 名>` を省いたときは `GITHUB_REF_NAME` を見る。どちらも無ければ「判定していない」と
 * 報告して終わる（⛔ 黙って緑にしない）。
 *
 * ⚠ **見ているのは節の存在だけである。**節の中身も、`docs/migration-v1.md` の世代も見ていない
 * ——見ていないことは、出力にも毎回書く。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeChangelogFollowUp } from "./release-changelog-section-lib.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function report(lines) {
  const text = lines.join("\n");
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

const tagName = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";

let changelogText = "";
let readError = null;
try {
  changelogText = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
} catch (err) {
  readError = String(err.message ?? err);
}

const header = "## リリース後の追随（⛔ 門ではない。何も止めていない）";

if (readError !== null) {
  report([header, "", `⚠ CHANGELOG.md を読めなかった: ${readError}`, "⟹ **判定していない。**"]);
  process.exit(0);
}

const verdict = describeChangelogFollowUp({ tagName, changelogText });
report([
  header,
  "",
  `- tag: \`${verdict.tagName || "(渡されていない)"}\``,
  `- 版: \`${verdict.version || "(導けない)"}\``,
  "",
  verdict.message,
  "",
  "⚠ **この通知が見ていないもの**: 節の中身 / `docs/migration-v1.md` の世代欄 /",
  "出荷済みの破壊的変更が正しい世代に置かれているか。⟹ **そこは人が見る**",
  "（`docs/release-v1.md` §5.5）。",
]);

// ⭐ 常に 0。上の doc コメントの理由による。
process.exit(0);
