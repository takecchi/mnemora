/**
 * 機械的な文字列切り詰めの共通部品。
 *
 * `extraction.ts` の `truncateForFallbackDigest`（docs/memory-model.md §4 の安全弁）と
 * `digest-band.ts` の `packDigestBand`（1件の digest の文字数上限）は、どちらも
 * `String.prototype.slice(0, n)` で先頭 n 文字（正確には UTF-16 コードユニット）を
 * 切り出す。
 *
 * ⚠ **サロゲートペア（絵文字等、UTF-16 で2コードユニットを使う文字）の内側で
 * 切ると、対になる片方を失った孤立サロゲートが残る。** 孤立サロゲートはそのまま
 * 保持している分には JS の文字列として不正ではないが、UTF-8 へエンコードする経路
 * （`packages/postgres` が node-postgres 経由で `content`/`digest` 列へ書き込むとき）で
 * 静かに U+FFFD（置換文字）へ壊れる——切り詰めという「安全弁」自身が、切り詰めて
 * いない部分よりも先にデータを壊してしまう。
 *
 * `truncationBoundary` は、素朴な `n` がサロゲートペアの内側を指しているときだけ
 * `n - 1` へ1つ戻す。ペアの外側（境界がちょうど文字の切れ目に当たる場合）は
 * 1文字も余計に削らない。
 */
export function truncationBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const isLowSurrogate = at >= 0xdc00 && at <= 0xdfff;
  return isHighSurrogate && isLowSurrogate ? index - 1 : index;
}

/**
 * `text.slice(0, maxLength)` の安全版——`maxLength` が負数なら0（`String.prototype.slice`
 * の「末尾から数える」意味論を避けるための下限）、`maxLength` がサロゲートペアの内側を
 * 指していれば1文字手前に丸める。
 */
export function sliceWithoutSplittingSurrogatePair(text: string, maxLength: number): string {
  const clamped = Math.max(0, maxLength);
  return text.slice(0, truncationBoundary(text, clamped));
}
