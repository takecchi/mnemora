/**
 * markdown リンク `[表示](url)` を表示文字だけにする置換の、**唯一の定義**（Issue #646）。
 *
 * ## ⛔ 定義をここ以外に書かない
 *
 * この置換は以前、`scripts/` の中に3箇所、別々に書かれていた
 * （`agents-md-quote-attribution-lib.mjs` の `delink`・`adr-citation-lib.mjs` の
 * `stripMarkdownDecoration`・同 `normalizeForAdrDecisionReferences`）。
 * 各歯は自分の正規化しか見ないので、**1箇所だけ直してもどのテストも赤くならず、静かにずれる。**
 * 【実例】PR #647 が塞いだ穴——`delink` は外し、`stripMarkdownDecoration` は外さなかった。
 * 【実例】`normalizeForAdrDecisionReferences` だけが改行を含むリンクを外さなかった。
 * ⟹ 3箇所ともこのファイルを import する。
 *
 * ## 🔴 CommonMark と違う —— 表示文字にも url にも改行を許さない
 *
 * CommonMark はリンクの表示文字の中の改行を許す。**ここでは許さない**
 * （`[^\]\n]` / `[^)\n]`）。
 *
 * 理由: 呼び手の1つ（`findAdrDecisionReferences`、#643 の歯3）は `.md` だけでなく
 * `.mjs`・`.ts` などのコードも読む。表示文字の改行を許すと、JS の**配列リテラル**の
 * `[` から、数行先に在る本物のリンクの `](` までを1つの偽リンクとして拾う。
 * 【実測】2026-09-23 の `main`（`b88d3f6`）で、この形の偽リンクは11件在った。
 * 一方、改行をまたぐ本物のリンクは `.md` に0件で、コード内のコメント・文字列に5件だけ在った。
 * ⟹ 3つの呼び手が repo の全入力に出す判定は、改行を許しても許さなくても1件も変わらなかった
 * （その比較は Issue #646 を着地させた PR の本文に在る）。**判定を変えずに誤りを減らせるほうを採った。**
 *
 * ## そのまま固定している振る舞い（`scripts/__tests__/markdown-link.test.mjs`）
 *
 * - 画像 `![alt](src)` は `!alt` になる（`!` は残る）。
 * - 入れ子の角括弧 `[a [b]](u)` は外さない（`[^\]]` が最初の `]` で止まるため）。
 * - 1行に収まる `[a, b](x)` は、コードの中に在ってもリンクとして外す（形では区別できない）。
 */

/**
 * リンク1個の形。グループ1 = 表示文字、グループ2 = url。
 * フラグは下の2つ（`g` = 置換 / `y` = 位置を決めて当てる）で付ける。
 */
const MARKDOWN_LINK_SOURCE = String.raw`\[([^\]\n]*)\]\(([^)\n]*)\)`;

const MARKDOWN_LINK_GLOBAL_RE = new RegExp(MARKDOWN_LINK_SOURCE, "g");
/** `lastIndex` を毎回設定してから使う（呼ぶたびに作らない。1文字ずつ呼ばれるため）。 */
const MARKDOWN_LINK_STICKY_RE = new RegExp(MARKDOWN_LINK_SOURCE, "y");

/**
 * `value` の中の markdown リンクを、すべて表示文字だけにする。
 *
 * @param {string} value
 * @returns {string}
 */
export function delinkMarkdown(value) {
  return value.replaceAll(MARKDOWN_LINK_GLOBAL_RE, "$1");
}

/**
 * `text` の位置 `index` から始まる markdown リンクを1個当てる（無ければ `null`）。
 * 元テキストの位置を追う必要がある呼び手（`normalizeForAdrDecisionReferences`）のため。
 *
 * @param {string} text
 * @param {number} index
 * @returns {{ display: string, url: string, length: number } | null}
 */
export function matchMarkdownLinkAt(text, index) {
  MARKDOWN_LINK_STICKY_RE.lastIndex = index;
  const m = MARKDOWN_LINK_STICKY_RE.exec(text);
  return m ? { display: m[1], url: m[2], length: m[0].length } : null;
}
