/**
 * `text` の先頭から、`maxLength`（UTF-16 コードユニット）以下に収まる最長の書記素の並びを返す。
 * 最初の書記素だけで `maxLength` を超えるなら空文字列を返す。`maxLength` が負数なら0として扱う。
 *
 * `@mnemora/core` の `sliceAtGraphemeBoundary`（`packages/core/src/text-truncation.ts`）の写し。
 * core から import しない理由: あれは core の内部関数で、`index.ts` から出していない。公開すると
 * 公開 API の snapshot（ADR 0178）が増え、語彙検索（lexical）の都合で core の公開面を広げることになる。
 * 切り詰めの規則を変えるときは両方を見ること。
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
