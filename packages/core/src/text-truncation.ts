/**
 * 機械的な文字列切り詰めの共通部品。
 *
 * `extraction.ts` の `truncateForFallbackDigest`（docs/memory-model.md §4 の安全弁）、
 * `digest-band.ts` の `packDigestBand`（1件の digest の文字数上限）、
 * `failure-description.ts` の失敗の説明の上限は、どれも {@link sliceAtGraphemeBoundary} で切る。
 *
 * ⚠ `String.prototype.slice(0, n)` はサロゲートペア（絵文字等、UTF-16 で2コードユニットを使う文字）の
 * 内側で切ると、対になる片方を失った孤立サロゲートを残す。UTF-8 へエンコードする経路
 * （`packages/postgres` が node-postgres 経由で `content`/`digest` 列へ書き込むとき）で
 * 静かに U+FFFD（置換文字）へ壊れる。結合文字・ZWJ の絵文字・国旗の途中で切っても、
 * 片割れだけが残る。切り詰めという「安全弁」自身がデータを壊さないよう、書記素の境界で切る。
 */

/**
 * `text` の先頭から、`maxLength`（UTF-16 コードユニット）以下に収まる最長の書記素の並びを返す
 * （穴 O-5、ADR 0424）。
 *
 * サロゲートペアの内側だけでなく、NFD の「が」（`か` + 結合濁点）の途中や、ZWJ で繋がった
 * 絵文字の途中でも切らない。`Intl.Segmenter`（書記素）の境界でだけ切る。単位は
 * コードユニットのまま。最初の書記素だけで `maxLength` を超えるなら空文字列を返す。
 * `maxLength` が負数なら0として扱う。
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
