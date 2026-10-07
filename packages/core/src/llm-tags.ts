/**
 * LLM が返した tags から、空文字・空白だけの要素を捨てる（`index.ts` からは出さない内部の関数）。
 *
 * 空白でない要素は、前後の空白・並び・重複も含めてそのまま残す（捨てる以外のことはしない）。
 * 抽出・統合・内省の3経路が、LLM の tags を Memory に書く前にこれを通す。
 */
export function dropBlankTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.trim() !== "");
}
