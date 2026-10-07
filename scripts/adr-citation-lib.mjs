/**
 * ADR 参照の検査の純関数側。ファイル I/O・`process.argv`・`process.exit` を持たない。
 * 入力テキストから機械的に見つかるものを全部返すだけで、ファイルパスや docs/decisions/ 所属は知らない。
 * 判定（除外するか・赤くするか）は呼び出し側（テスト）が決める。
 *
 * ⛔ `ADR <4桁>` の後ろに文字数の窓を張って「NNN〜NNN行付近」形を拾うことはしない。
 * 「ADR 0067 は `#` の見出しを1行目にしか持たず」のような構造の記述と間隔の長さで区別できず、偽陽性が出る。
 * ⚠ `anchorExistsInTarget` の末尾数字除去は、節の存在までしか確認しない。
 */

import { delinkMarkdown, matchMarkdownLinkAt } from "./markdown-link-lib.mjs";

/**
 * @typedef {{
 *   index: number,
 *   line: number,
 *   raw: string,
 *   adrNumber: string,
 *   kind: "combined" | "adr-comma-line" | "adr-paren-colon" | "md-link-colon" | "omitted-reference",
 * }} AdrLineCitation
 */

/**
 * @typedef {{ index: number, line: number, raw: string, adrNumber: string, quote: string }} AdrAnchorCitation
 */

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
export function lineNumberAt(text, index) {
  let line = 1;
  const upTo = text.slice(0, index);
  for (let i = 0; i < upTo.length; i++) {
    if (upTo[i] === "\n") {
      line++;
    }
  }
  return line;
}

const FILE_LINE_RE = /`((?:docs\/decisions\/)?(\d{4})-\S+?\.md):([0-9][0-9,\s-]{0,60})`/g;
const ADR_COMMA_LINE_RE = /ADR\s*(\d{4})[、,]\s*(\d+(?:[-〜~]\d+)?行(?:目|付近)?)/g;
const ADR_PAREN_COLON_RE = /ADR\s*(\d{4})\s*[（(]\s*`:(\d+(?:-\d+)?)`\s*[）)]/g;
const MD_LINK_COLON_RE = /\[ADR\s*(\d{4})\]\([^)\n]*\)(?:\s*の)?\s*`:(\d+(?:-\d+)?)`/g;
const OMITTED_COLON_RE = /同(?:ファイル)?\s*`:(\d+(?:-\d+)?)`/g;

const ADR_FILE_MENTION_RE = /`(?:docs\/decisions\/)?(\d{4})-\S+?\.md`/g;
const ADR_BARE_MENTION_RE = /ADR\s*(\d{4})/g;
const OTHER_FILE_MENTION_RE = /`([^`\n]*\.(?:ts|tsx|js|mjs|cjs|json|sql|ya?ml))[^`\n]*`/g;

/**
 * @param {string} text
 * @returns {Array<{ index: number, end: number, isAdr: boolean, adrNumber: string | null }>}
 */
function collectMentions(text) {
  /** @type {Array<{ index: number, end: number, isAdr: boolean, adrNumber: string | null }>} */
  const mentions = [];

  for (const re of [ADR_FILE_MENTION_RE, ADR_BARE_MENTION_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      mentions.push({ index: m.index, end: re.lastIndex, isAdr: true, adrNumber: m[1] });
    }
  }

  OTHER_FILE_MENTION_RE.lastIndex = 0;
  let om;
  while ((om = OTHER_FILE_MENTION_RE.exec(text))) {
    mentions.push({
      index: om.index,
      end: OTHER_FILE_MENTION_RE.lastIndex,
      isAdr: false,
      adrNumber: null,
    });
  }

  FILE_LINE_RE.lastIndex = 0;
  let fm;
  while ((fm = FILE_LINE_RE.exec(text))) {
    mentions.push({ index: fm.index, end: FILE_LINE_RE.lastIndex, isAdr: true, adrNumber: fm[2] });
  }
  MD_LINK_COLON_RE.lastIndex = 0;
  let lm;
  while ((lm = MD_LINK_COLON_RE.exec(text))) {
    mentions.push({
      index: lm.index,
      end: MD_LINK_COLON_RE.lastIndex,
      isAdr: true,
      adrNumber: lm[1],
    });
  }

  mentions.sort((a, b) => a.index - b.index);
  return mentions;
}

/**
 * @param {Array<{ index: number, end: number, isAdr: boolean, adrNumber: string | null }>} mentions
 * @param {number} position
 */
function nearestPrecedingMention(mentions, position) {
  let best = null;
  for (const mention of mentions) {
    if (mention.end <= position) {
      if (!best || mention.end > best.end) {
        best = mention;
      }
    } else {
      break;
    }
  }
  return best;
}

/**
 * @param {string} text
 * @returns {AdrLineCitation[]}
 */
export function findAdrLineNumberCitations(text) {
  /** @type {AdrLineCitation[]} */
  const citations = [];

  FILE_LINE_RE.lastIndex = 0;
  let m;
  while ((m = FILE_LINE_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[2],
      kind: "combined",
    });
  }

  ADR_COMMA_LINE_RE.lastIndex = 0;
  while ((m = ADR_COMMA_LINE_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[1],
      kind: "adr-comma-line",
    });
  }

  ADR_PAREN_COLON_RE.lastIndex = 0;
  while ((m = ADR_PAREN_COLON_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[1],
      kind: "adr-paren-colon",
    });
  }

  MD_LINK_COLON_RE.lastIndex = 0;
  while ((m = MD_LINK_COLON_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[1],
      kind: "md-link-colon",
    });
  }

  const mentions = collectMentions(text);
  OMITTED_COLON_RE.lastIndex = 0;
  while ((m = OMITTED_COLON_RE.exec(text))) {
    const antecedent = nearestPrecedingMention(mentions, m.index);
    if (antecedent && antecedent.isAdr && antecedent.adrNumber) {
      citations.push({
        index: m.index,
        line: lineNumberAt(text, m.index),
        raw: m[0],
        adrNumber: antecedent.adrNumber,
        kind: "omitted-reference",
      });
    }
  }

  citations.sort((a, b) => a.index - b.index);
  return citations;
}

const ANCHOR_RE =
  /(?:\[ADR\s*(\d{4})\]\([^)\n]*\)|ADR\s*(\d{4}))([^「\n。]{0,30})「([^」\n]{1,200})」/g;

/**
 * @param {string} text
 * @returns {AdrAnchorCitation[]}
 */
export function findAdrAnchorCitations(text) {
  /** @type {AdrAnchorCitation[]} */
  const citations = [];
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(text))) {
    const adrNumber = m[1] ?? m[2];
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber,
      quote: m[4],
    });
  }
  return citations;
}

/**
 * @param {string} quote
 * @returns {string}
 */
function stripTrailingIndex(quote) {
  return quote.replace(/[0-9０-９]+\s*番?$/u, "").trimEnd();
}

/**
 * ⛔ リンクの置換はここに書かない。定義は `markdown-link-lib.mjs` だけに在る。
 *
 * @param {string} value
 * @returns {string}
 */
function stripMarkdownDecoration(value) {
  return delinkMarkdown(value).replaceAll("**", "").replaceAll("`", "");
}

/**
 * @param {string} quote
 * @param {string} targetText
 * @returns {boolean}
 */
export function anchorExistsInTarget(quote, targetText) {
  if (quote.length === 0) {
    return false;
  }
  if (targetText.includes(quote)) {
    return true;
  }
  const stripped = stripTrailingIndex(quote);
  if (stripped.length > 0 && stripped !== quote && targetText.includes(stripped)) {
    return true;
  }
  const normalizedTarget = stripMarkdownDecoration(targetText);
  const normalizedQuote = stripMarkdownDecoration(quote).trim();
  if (normalizedQuote.length > 0 && normalizedTarget.includes(normalizedQuote)) {
    return true;
  }
  const normalizedStripped = stripTrailingIndex(normalizedQuote);
  if (
    normalizedStripped.length > 0 &&
    normalizedStripped !== normalizedQuote &&
    normalizedTarget.includes(normalizedStripped)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {{ normalized: string, indexMap: number[] }}
 */
export function normalizeForAdrDecisionReferences(text) {
  const outChars = [];
  const indexMap = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    // ⛔ リンクの形はここに書かない。`markdown-link-lib.mjs` だけに在る。
    const linkMatch = text[i] === "[" ? matchMarkdownLinkAt(text, i) : null;
    if (linkMatch) {
      const display = linkMatch.display;
      const displayStart = i + 1; // '[' の次から表示文字が始まる
      for (let k = 0; k < display.length; k++) {
        outChars.push(display[k]);
        indexMap.push(displayStart + k);
      }
      i += linkMatch.length;
      continue;
    }
    const ch = text[i];
    if (ch === "*" || ch === "_" || ch === "`" || ch === "~" || ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "|") {
      outChars.push(" ");
      indexMap.push(i);
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      const start = i;
      while (i < n && /\s/.test(text[i])) {
        i += 1;
      }
      outChars.push(" ");
      indexMap.push(start);
      continue;
    }
    outChars.push(ch);
    indexMap.push(i);
    i += 1;
  }
  return { normalized: outChars.join(""), indexMap };
}

/** @typedef {{ index: number, line: number, raw: string, adrNumber: string, decisionNumber: string }} AdrDecisionReference */

const ADR_DECISION_REF_RE = /ADR ?(\d{4}) ?決定 ?(\d+)/g;

/**
 * @param {string} text
 * @returns {AdrDecisionReference[]}
 */
export function findAdrDecisionReferences(text) {
  const { normalized, indexMap } = normalizeForAdrDecisionReferences(text);
  /** @type {AdrDecisionReference[]} */
  const citations = [];
  ADR_DECISION_REF_RE.lastIndex = 0;
  let m;
  while ((m = ADR_DECISION_REF_RE.exec(normalized))) {
    const originalIndex = indexMap[m.index] ?? 0;
    citations.push({
      index: originalIndex,
      line: lineNumberAt(text, originalIndex),
      raw: m[0],
      adrNumber: m[1],
      decisionNumber: m[2],
    });
  }
  return citations;
}

/**
 * 🔴 行頭に空白と `- + * >` を許すこと。`^#{2,4}` に戻すと、箇条書きの中に字下げして置かれた見出しを拾えず、
 * 参照が静かに「判定不能」になる。
 *
 * @param {string} line
 * @returns {{ level: number, text: string } | null}
 */
const HEADING_LINE_RE = /^[ \t]*(?:[-+*>][ \t]*)*(#{2,4})[ \t]+(.*)$/;
function matchHeadingLine(line) {
  const m = HEADING_LINE_RE.exec(line);
  if (!m) {
    return null;
  }
  return { level: m[1].length, text: m[2] };
}

function stripHeadingDecoration(text) {
  return text
    .replace(/[⭐🔴⚠⛔⭕🟢🔵💡]/gu, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

const DECISION_SECTION_TITLES = new Set(["決めたこと", "決定", "決めること", "結論"]);

/**
 * @param {string} adrText
 * @returns {Set<string>}
 */
export function findAdrDecisionSectionNumbers(adrText) {
  const lines = adrText.split("\n");
  const numbers = new Set();
  /** @type {{ kind: "heading", level: number } | { kind: "bullet", indent: number } | null} */
  let container = null;

  const BULLET_LABEL_RE = /^([ \t]*)[-+*]\s+\*\*(決めたこと|決定|決めること|結論)\*\*\s*:?\s*$/;
  const BULLET_ITEM_RE = /^[ \t]*[-+*]\s/;

  for (const line of lines) {
    const heading = matchHeadingLine(line);
    if (heading) {
      const headingText = stripHeadingDecoration(heading.text);

      const directMatch = headingText.match(/^決定\s*(\d+)/);
      if (directMatch) {
        numbers.add(directMatch[1]);
        if (container?.kind === "bullet") {
          container = null;
        }
        continue;
      }

      if (DECISION_SECTION_TITLES.has(headingText)) {
        container = { kind: "heading", level: heading.level };
        continue;
      }

      if (container?.kind === "heading" && heading.level > container.level) {
        const bareMatch = headingText.match(/^(\d+)\./);
        if (bareMatch) {
          numbers.add(bareMatch[1]);
        }
        continue;
      }

      container = null;
      continue;
    }

    const bulletLabel = line.match(BULLET_LABEL_RE);
    if (bulletLabel) {
      container = { kind: "bullet", indent: bulletLabel[1].length };
      continue;
    }

    if (container === null) {
      continue;
    }

    if (container.kind === "bullet") {
      const siblingBullet = line.match(BULLET_ITEM_RE);
      if (siblingBullet) {
        const indent = line.match(/^[ \t]*/)[0].length;
        if (indent <= container.indent) {
          container = null;
          continue;
        }
      }
    }

    const boldParagraphMatch = line.match(/^[ \t]*\*\*(\d+)\.\s/);
    if (boldParagraphMatch) {
      numbers.add(boldParagraphMatch[1]);
      continue;
    }
    const bulletMatch = line.match(/^[ \t]*(\d+)\.\s/);
    if (bulletMatch) {
      numbers.add(bulletMatch[1]);
      continue;
    }
    const tableMatch = line.match(/^[ \t]*\|\s*(\d+)\s*\|/);
    if (tableMatch) {
      numbers.add(tableMatch[1]);
    }
  }

  return numbers;
}

const ADR_LANDING_CLAIM_RE = /ADR ?(\d{4}) ?決定 ?(\d+) の射程を[^\n]*?へ広げる/;

/**
 * ⚠ 正規化を掛けない素の h1 に直接当てる（リンク記法・改行をまたぐ書き方は想定しない）。
 *
 * @param {string} adrText
 * @returns {{ sourceAdrNumber: string, decisionNumber: string } | null}
 */
export function findAdrLandingClaim(adrText) {
  const firstLine = adrText.split("\n", 1)[0] ?? "";
  const m = ADR_LANDING_CLAIM_RE.exec(firstLine);
  if (!m) {
    return null;
  }
  return { sourceAdrNumber: m[1], decisionNumber: m[2] };
}

/**
 * ⛔ 規則Bは「番号が一致するときだけ」立てる。`Boolean(targetLandingClaim)` にすると、
 * X が何かの着地先でありさえすれば毎回立つ過剰実装になる。
 *
 * @param {string} decisionNumber
 * @param {{ targetSectionNumbers: Set<string> | null, targetLandingClaim: { sourceAdrNumber: string, decisionNumber: string } | null }} target
 * @returns {{ ruleA: boolean, ruleB: boolean }}
 */
export function classifyAdrDecisionCitation(decisionNumber, target) {
  if (target.targetSectionNumbers === null) {
    return { ruleA: true, ruleB: false };
  }
  const ruleA = !target.targetSectionNumbers.has(decisionNumber);
  const ruleB = Boolean(
    target.targetLandingClaim && target.targetLandingClaim.decisionNumber === decisionNumber,
  );
  return { ruleA, ruleB };
}
