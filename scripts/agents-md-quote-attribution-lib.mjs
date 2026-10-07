/**
 * ⛔ `scripts/adr-citation-lib.mjs` とは契約が違うので、ファイルを分けてある。あちらの歯は `docs/decisions/` を
 * 意図して除外していて、同じファイルに `docs/decisions/` を対象にする検出器を足すと、互いに逆の射程が2つになる。
 * ただし正規化は一元化したいので、`anchorExistsInTarget` は import して再利用する(写さない)。
 *
 * 🔴 窓を2つ持つ。門にしてよいのは帰属の直後という狭い窓だけで、離れた形も拾う広い窓は報告のみ(止めない)。
 * 広げるほど「無関係な鉤括弧」を拾う偽陽性が増え、門にすると無実の追記が赤で止まる
 * (ADR 0223 決定3、ADR 0254)。
 *
 * ⚠ 言えるのは、いまの `AGENTS.md` にその文字列が在るかだけ。書かれた当時合っていたか、
 * 意味が合っているかは言えない。
 */

import { anchorExistsInTarget } from "./adr-citation-lib.mjs";
import { delinkMarkdown } from "./markdown-link-lib.mjs";

/**
 * ⛔ リンクを外す置換をここに書かない。定義は `markdown-link-lib.mjs` だけに在る。
 */
const delink = delinkMarkdown;
const joinLines = (s) => s.replaceAll(/\n\s*/g, "");
const stripDecoration = (s) => s.replaceAll("**", "").replaceAll("`", "");

export const normalizeLinksAndLines = (s) => stripDecoration(joinLines(delink(s)));
export const normalizeNestedQuotes = (s) =>
  normalizeLinksAndLines(s).replaceAll(/[『』]/g, (m) => (m === "『" ? "「" : "」"));
export const normalizeDashes = (s) =>
  normalizeNestedQuotes(s)
    .replaceAll(/[—–‐−ー-]+/g, "-")
    .replaceAll(/\s+/g, "");
export const normalizePunctuation = (s) =>
  normalizeDashes(s)
    .replaceAll(/[「」『』、。,.]/g, "")
    .replaceAll("#", "");

const STAGES = [
  normalizeLinksAndLines,
  normalizeNestedQuotes,
  normalizeDashes,
  normalizePunctuation,
];

/**
 * @returns {{exists: boolean, stage: number}} `stage` は何段目で当たったか（0 = 当たらなかった）
 */
export function quoteExistsInAgentsMd(quote, agentsMdText) {
  if (quote.length === 0) return { exists: false, stage: 0 };
  if (anchorExistsInTarget(quote, agentsMdText)) return { exists: true, stage: 1 };
  for (let i = 0; i < STAGES.length; i++) {
    if (STAGES[i](agentsMdText).includes(STAGES[i](quote))) return { exists: true, stage: i + 2 };
  }
  return { exists: false, stage: 0 };
}

function takeNestedQuote(text, start) {
  let depth = 0;
  for (let k = start; k < text.length; k++) {
    if (text[k] === "「") depth++;
    else if (text[k] === "」") {
      depth--;
      if (depth === 0) return text.slice(start + 1, k);
    }
  }
  return null;
}

const ATTRIBUTION = "AGENTS.md";
const NARROW_GAP = /^[`\s、。・）)]{0,4}[「『]/;

/**
 * @param {string} text
 * @returns {{quote: string}[]}
 */
export function findNarrowAgentsMdQuotes(text) {
  const flat = joinLines(text);
  const found = [];
  let i = -1;
  while ((i = flat.indexOf(ATTRIBUTION, i + 1)) !== -1) {
    const rest = flat.slice(i + ATTRIBUTION.length);
    const gap = rest.match(NARROW_GAP);
    if (!gap) continue;
    const open = i + ATTRIBUTION.length + gap[0].length - 1;
    const quote =
      flat[open] === "「" ? takeNestedQuote(flat, open) : rest.slice(gap[0].length).split("』")[0];
    if (quote && quote.length >= 3) found.push({ quote });
  }
  return found;
}

/**
 * ⛔ 門にしない。報告のみ。
 *
 * @param {string} text
 * @param {number} [gap] 帰属から鉤括弧までに許す文字数
 * @returns {{quote: string}[]}
 */
export function findWideAgentsMdQuotes(text, gap = 40) {
  const flat = joinLines(text);
  const narrow = new Set(findNarrowAgentsMdQuotes(text).map((c) => c.quote));
  const found = [];
  let i = -1;
  while ((i = flat.indexOf(ATTRIBUTION, i + 1)) !== -1) {
    const base = i + ATTRIBUTION.length;
    const window = flat.slice(base, base + gap);
    // ⚠ 窓の中の最初の鉤括弧だけを見ると、狭い窓で既に拾った引用が先に在るときに後ろを見落とす。窓の中を全部見る。
    for (let open = window.indexOf("「"); open !== -1; open = window.indexOf("「", open + 1)) {
      const quote = takeNestedQuote(flat, base + open);
      if (quote && quote.length >= 3 && !narrow.has(quote)) found.push({ quote });
    }
  }
  return found;
}
