/**
 * **`CHANGELOG.md` の見出しが「released の節」の形をしているかを見る、純粋な述語。**
 *
 * ## 🔴 2026-09-23 —— **このファイルは門ではなくなった**
 *
 * **もともとここには、`npm publish` の前に「出す版の節が `CHANGELOG.md` に在るか」を判定する
 * 門の本体（`decideReleaseChangelogGate`）が在った**（[ADR 0252](../docs/decisions/0252-release-changelog-section-is-a-publish-gate.md)）。
 * ⟹ **その門はオーナーの判断で撤回された**
 * （[ADR 0267](../docs/decisions/0267-withdraw-the-release-changelog-publish-gate.md)）。
 * ⟹ **判定の本体と、それを呼んでいた `check-release-changelog-section-gate.mjs` は消えている。**
 *
 * ⚠ **ファイル名に `gate` が残っているのは、改名しなかったからである。**
 * ⛔ **改名しなかった理由**: ADR 0252 の本文がこのパスを名指ししており、
 * **採用済み ADR の本文は書き換えない**（`docs/decisions/README.md`）。
 * ⟹ **改名すると、0252 の記録が存在しないパスを指す。**
 * ⭐ **名前と中身のずれは、引き受けた負債として ADR 0267 に書いてある。**
 *
 * ## ⭐ なぜ述語だけが残るのか
 *
 * **`isReleasedHeading` は門の持ち物ではなかったからである。**
 * これを使っているのは `scripts/__tests__/changelog-released-heading-format.test.mjs` であり、
 * その歯が測っているのは **`CHANGELOG.md` の見出しの形そのもの**——
 * 🔴 **とくに「未リリース節を *起こす* のではなく *足して* しまい、同じ版の見出しが2本になる」
 * 事故の検出**である。**これは publish を止める話とは独立に効く。**
 * ⟹ ⛔ **門を撤回したついでに道連れにしないこと。**
 */

/**
 * **released の節の見出しの形**。`## [0.5.0] - 2026-09-21` に当たり、
 * `## [1.0.0] - 未リリース` には当たらない。
 *
 * ⚠ **日付が実在するか（13月・32日でないか）は見ていない。**見たいのは
 * 「**未リリース節と区別できるか**」であって、日付の妥当性ではない
 * ——厳しくすると、正しい節を誤って落とす側の危険が増える。
 */
const RELEASED_HEADING = /^##\s+\[[^\]]+\]\s+-\s+\d{4}-\d{2}-\d{2}\s*$/;

/**
 * 見出し1行が「released の節」の形をしているか。
 *
 * @param {unknown} line
 * @returns {boolean}
 */
export function isReleasedHeading(line) {
  return RELEASED_HEADING.test(String(line ?? ""));
}
