/**
 * 機械的な文字列切り詰めの共通部品。fallback digest・digest 帯・失敗の説明の上限は、どれも
 * {@link sliceAtGraphemeBoundary} で切る。
 *
 * `String.prototype.slice(0, n)` は、サロゲートペアの内側で切ると孤立サロゲートを残し、UTF-8 へ
 * エンコードする経路で U+FFFD に壊れる。結合文字・ZWJ の絵文字・国旗の途中でも片割れが残る。
 * 切り詰めがデータを壊さないよう、書記素の境界で切る。
 */

/**
 * `text` の先頭から、`maxLength`（UTF-16 コードユニット）以下に収まる最長の書記素の並びを返す
 * （ADR 0424）。
 *
 * `Intl.Segmenter`（書記素）の境界でだけ切る。単位はコードユニットのまま。最初の書記素だけで
 * `maxLength` を超えるなら空文字列を返す。`maxLength` が負数なら0として扱う。
 */
export function sliceAtGraphemeBoundary(text: string, maxLength: number): string {
  const limit = Math.max(0, maxLength);
  if (text.length <= limit) {
    return text;
  }
  let end = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const next = index + segment.length;
    if (next > limit) {
      break;
    }
    end = next;
  }
  return text.slice(0, end);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
