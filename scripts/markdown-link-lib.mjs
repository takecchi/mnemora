/**
 * markdown リンク置換の唯一の定義。呼び手ごとに書き写さず、必ずここを import する
 * （写すと1箇所だけ直って静かにずれる）。
 * 表示文字にも url にも改行を許さない（CommonMark とは違う）。許すと、コード内の配列リテラルの `[` から
 * 数行先の本物のリンクの `](` までを偽リンクとして拾う。
 */

const MARKDOWN_LINK_SOURCE = String.raw`\[([^\]\n]*)\]\(([^)\n]*)\)`;

const MARKDOWN_LINK_GLOBAL_RE = new RegExp(MARKDOWN_LINK_SOURCE, "g");
/** `lastIndex` を毎回設定してから使う（1文字ずつ呼ばれるので、呼ぶたびに作らない）。 */
const MARKDOWN_LINK_STICKY_RE = new RegExp(MARKDOWN_LINK_SOURCE, "y");

/**
 * @param {string} value
 * @returns {string}
 */
export function delinkMarkdown(value) {
  return value.replaceAll(MARKDOWN_LINK_GLOBAL_RE, "$1");
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {{ display: string, url: string, length: number } | null}
 */
export function matchMarkdownLinkAt(text, index) {
  MARKDOWN_LINK_STICKY_RE.lastIndex = index;
  const m = MARKDOWN_LINK_STICKY_RE.exec(text);
  return m ? { display: m[1], url: m[2], length: m[0].length } : null;
}
