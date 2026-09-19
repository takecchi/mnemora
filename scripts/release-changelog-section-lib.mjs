/**
 * 出したリリースの tag に対応する節が `CHANGELOG.md` に在るか**だけ**を見る純関数。
 *
 * ## ⛔ この述語をこれ以上広げないこと
 *
 * [Issue #433](https://github.com/takecchi/mnemora/issues/433) は「載せ漏れを CI の歯で
 * 見る」案を検討し、**却下している**（2026-09-17 のコメント、逐語「**(い) 現状維持。
 * 着地済みの ADR 0214 決定6 を追認する。⛔ CI の歯は作らない**」）。
 * 却下の芯は [ADR 0214](../docs/decisions/0214-release-candidates-lists-not-judges.md)
 * 決定1 の「**門になった瞬間、『これが全部だ』と主張したことになる**」である。
 *
 * 🔴 **却下されたのは「commit ごとに載せるべきかを推定する内容ヒューリスティック」という
 * 述語であって、「出た tag に対応する節が在るか」ではない。**
 * ⟹ **この場所で内容の推定を始めると、却下された側へ戻る。**節の**存在**だけを見ること。
 *
 * ## 数も tag も焼き込まない
 *
 * 版は実行時に渡される tag からその場で導く（`AGENTS.md`「⚠ 数を、道具と生成物に
 * 焼き込まない」/ [ADR 0234](../docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。
 */

/**
 * `v1.2.3` のような tag 名から、`CHANGELOG.md` の節が名乗る版文字列を導く。
 * ⚠ 先頭の `v` は**1つだけ**落とす（`vv1.2.3` のような tag は、そのまま扱って外す）。
 *
 * @param {string} tagName
 * @returns {string}
 */
export function versionFromTagName(tagName) {
  const trimmed = String(tagName ?? "").trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

/**
 * `## [<version>]` で始まる見出し行を探す。
 *
 * ⚠ 版の直後が `]` であることを要求する——そうしないと `1.2.3` が `1.2.30` の節に
 * 当たってしまう（**存在しない節を「在る」と報告する**、いちばん困る外し方である）。
 * ⭐ 見出しの後続（` - 2026-09-19` 等）は問わない。
 *
 * @param {string} changelogText
 * @param {string} version
 * @returns {{ found: boolean, lineNumber: number | null, line: string | null }}
 */
export function findChangelogSection(changelogText, version) {
  const lines = String(changelogText ?? "").split("\n");
  const needle = `## [${version}]`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(needle)) {
      return { found: true, lineNumber: i + 1, line: lines[i] };
    }
  }
  return { found: false, lineNumber: null, line: null };
}

/**
 * 通知に出す1件ぶんの判定。⛔ **例外を投げない**——この道具は何も止めない側である。
 *
 * @param {{ tagName: string, changelogText: string }} input
 * @returns {{ tagName: string, version: string, found: boolean, lineNumber: number | null, message: string }}
 */
export function describeChangelogFollowUp({ tagName, changelogText }) {
  const version = versionFromTagName(tagName);
  if (version === "") {
    return {
      tagName: String(tagName ?? ""),
      version,
      found: false,
      lineNumber: null,
      message: "⚠ tag 名が空である。判定していない（この道具は何も止めない——人が見ること）。",
    };
  }
  const hit = findChangelogSection(changelogText, version);
  if (hit.found) {
    return {
      tagName,
      version,
      found: true,
      lineNumber: hit.lineNumber,
      message:
        `⭕ CHANGELOG.md に \`## [${version}]\` の節が在る（${hit.lineNumber} 行目）。` +
        "\n⛔ 節の**中身**が正しいかは見ていない。⛔ docs/migration-v1.md の世代も見ていない。",
    };
  }
  return {
    tagName,
    version,
    found: false,
    lineNumber: null,
    message:
      `🔴 CHANGELOG.md に \`## [${version}]\` の節が無い。` +
      `\n⟹ 出した版の節が起きていない可能性がある（同じ形が v0.3.0 と v0.4.0 で2回起きている）。` +
      "\n⛔ これは門ではない。何も止めていない——人が読んで判断すること。",
  };
}
