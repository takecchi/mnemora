/**
 * 「ADR が `AGENTS.md` を括って引いた文が、原典に実在するか」を検査する純関数の側
 * （Issue #636）。
 *
 * ## ⛔ `scripts/adr-citation-lib.mjs` と *契約が違う* ので、ファイルを分けてある
 *
 * `adr-citation-lib.mjs` は **生きた文書 → ADR** の向きを見る歯であり、
 * その歯（`scripts/__tests__/adr-citation.test.mjs`）は `docs/decisions/` を
 * **意図して除外している**。⟹ その除外はあの歯の契約の一部である。
 * 同じファイルに「`docs/decisions/` を *対象にする* 検出器」を足すと、1つのファイルが
 * 互いに逆の射程を2つ持つことになり、次に読む人はどちらがどちらに掛かるか分からなくなる。
 * ⟹ **契約が違うものは、ファイルを分ける。**
 * ⭕ ただし正規化は一元化したいので、`anchorExistsInTarget` は **import して再利用する**
 * （写さない）。
 *
 * ## 🔴 窓を2つ持つ理由 —— 門にしてよいのは狭いほうだけである
 *
 * | | 窓 | 扱い |
 * |---|---|---|
 * | **門** | 帰属の *直後*（`AGENTS.md` の直後に鉤括弧） | 赤で止める |
 * | **報告** | 帰属と鉤括弧が離れた形も拾う | ⛔ **止めない。**一覧を出すだけ |
 *
 * 窓を広げて拾う偽陽性は「`AGENTS.md` に言及した後、*無関係な* 鉤括弧が続く」形であり、
 * その中身は当然 `AGENTS.md` に無い ⟹ **広げるほど「誤った腐り報告」が増える**
 * ⟹ 門にすると無実の追記が赤で止まる。
 * `AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」
 * （[ADR 0223](../docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定3 /
 * [ADR 0254](../docs/decisions/0254-no-gate-without-a-false-positive-ceiling.md)）に従い、
 * **上限を置ける狭い窓だけを門にし、置けない広い窓は「代わりに置いたもの」＝報告として出す。**
 *
 * ## ⚠ この道具が言えること / 言えないこと
 *
 * - ⭕ 言える: **いまの `AGENTS.md` に、その文字列が在るか。**
 * - ⛔ 言えない: **書かれた当時 合っていたか。**（`AGENTS.md` は動く。実例として
 *   `AGENTS.md` は「複製した瞬間から、正文と要約はずれ始める」と
 *   「複製した瞬間から、正本と写しはずれ始める」を別々の箇所に持っている。）
 * - ⛔ 言えない: **意味が合っているか。**逐語が在っても、引用者が主張した趣旨が
 *   原典のその節の趣旨とは違うことがある。
 */

import { anchorExistsInTarget } from "./adr-citation-lib.mjs";
import { delinkMarkdown } from "./markdown-link-lib.mjs";

/**
 * markdown リンク `[表示](url)` を表示文字だけにする。原典側がリンクだと逐語比較が空振りする。
 * ⛔ 置換をここに書かない——定義は `markdown-link-lib.mjs` だけに在る（Issue #646）。
 */
const delink = delinkMarkdown;
/** 行送りで割れた語をつなぐ。引用側・原典側の両方で起きる。 */
const joinLines = (s) => s.replaceAll(/\n\s*/g, "");
const stripDecoration = (s) => s.replaceAll("**", "").replaceAll("`", "");

/** 段2: リンク・行送り・装飾。 */
export const normalizeLinksAndLines = (s) => stripDecoration(joinLines(delink(s)));
/** 段3: 日本語の入れ子作法で `「」` が `『』` に変わる分を戻す。 */
export const normalizeNestedQuotes = (s) =>
  normalizeLinksAndLines(s).replaceAll(/[『』]/g, (m) => (m === "『" ? "「" : "」"));
/** 段4: ダッシュ幅（`—` / `——` / `-`）と空白。 */
export const normalizeDashes = (s) =>
  normalizeNestedQuotes(s)
    .replaceAll(/[—–‐−ー-]+/g, "-")
    .replaceAll(/\s+/g, "");
/** 段5: 句読点・鉤括弧・見出し記号。 */
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
 * `quote` が `agentsMdText` に実在するかを、段階的に正規化しながら当てる。
 * 段1 は `adr-citation-lib.mjs` の `anchorExistsInTarget` をそのまま使う（写さない）。
 *
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

/** `text[start]` が `「` のとき、入れ子（`『』` は中身として許す）に対応して閉じ括弧までを返す。 */
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
/** 帰属と鉤括弧の間に許す文字（閉じバッククォート・空白・読点・閉じ括弧）。 */
const NARROW_GAP = /^[`\s、。・）)]{0,4}[「『]/;

/**
 * 帰属の *直後* に鉤括弧が来る形だけを返す（＝門にしてよい狭い窓）。
 * 行送りは先に潰すので、`AGENTS.md` と `「` が別行に割れていても拾う。
 *
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
 * 帰属と鉤括弧が離れた形も返す（⛔ 門にしない。報告のみ）。
 * 狭い窓で既に拾えたものは含めない。
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
    // ⚠ 窓の中の *最初の* 鉤括弧だけを見ると、狭い窓で既に拾った引用が先に在るときに
    // その後ろを見落とす（この歯の単体テストが実際に捕まえた）。⟹ 窓の中を全部見る。
    for (let open = window.indexOf("「"); open !== -1; open = window.indexOf("「", open + 1)) {
      const quote = takeNestedQuote(flat, base + open);
      if (quote && quote.length >= 3 && !narrow.has(quote)) found.push({ quote });
    }
  }
  return found;
}
