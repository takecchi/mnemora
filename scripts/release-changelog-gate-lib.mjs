/**
 * ⛔ ファイル名に `gate` が残っているのは改名しなかったからである。採用済み ADR(0252)の本文がこのパスを名指ししており、採用済み ADR の本文は書き換えない。
 * 改名すると 0252 の記録が存在しないパスを指す。名前と中身のずれは ADR 0267 に負債として書いてある。
 *
 * ⛔ 述語だけが残るのは、`changelog-released-heading-format.test.mjs` が `CHANGELOG.md` の見出しの形(同じ版の見出しが2本になる事故の検出)を測っているため。publish 門の撤回と一緒に消さない。
 */

/**
 * ⚠ 日付が実在するか(13月・32日でないか)は見ていない。見たいのは未リリース節と区別できるかで、厳しくすると正しい節を誤って落とす危険が増える。
 */
const RELEASED_HEADING = /^##\s+\[[^\]]+\]\s+-\s+\d{4}-\d{2}-\d{2}\s*$/;

/**
 * @param {unknown} line
 * @returns {boolean}
 */
export function isReleasedHeading(line) {
  return RELEASED_HEADING.test(String(line ?? ""));
}
