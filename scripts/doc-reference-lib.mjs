import ts from "typescript";
import { lineNumberAt } from "./adr-citation-lib.mjs";
import { matchMarkdownLinkAt } from "./markdown-link-lib.mjs";

/**
 * ⛔ 門にしないもの: アンカーの存在(GitHub の見出しスラグの規則を正確に写せる保証が無い)・Issue / PR 番号・`file:line`・
 * ADR 本文・文書を名指ししない裸の `§N`。一覧を出すだけの警告も置かない(読まれずに腐る)。
 *
 * ⚠ TS はコメントの外(正規表現・文字列)にも `[…](…)` の形が現れうるので、`commentTextOf` でコメント以外を空白に潰してから渡す。
 * markdown はコードブロックの中を潰す(`maskMarkdownCodeFences`)。どちらも改行は残し、行番号を元の文書と一致させる。
 */

/**
 * @typedef {object} ReferenceEnv
 * @property {(repoRelativePath: string) => boolean} exists
 * @property {(adrNumber: string) => boolean} adrExists
 * @property {(repoRelativePath: string) => Set<string> | null} headingNumbers
 */

/**
 * @typedef {object} BrokenReference
 * @property {"link" | "adr" | "section"} kind
 * @property {string} file
 * @property {number} line
 * @property {string} ref
 * @property {string} reason
 */

export function resolveRepoPath(fromFile, relative) {
  const base = fromFile.split("/").slice(0, -1);
  const parts = [...base, ...relative.split("/")];
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join("/");
}

export function commentTextOf(tsText) {
  const sf = ts.createSourceFile("x.ts", tsText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const ranges = new Map();
  const add = (list) => {
    for (const r of list ?? []) ranges.set(r.pos, r.end);
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(tsText, node.pos));
    add(ts.getTrailingCommentRanges(tsText, node.end));
    const children = node.getChildren(sf);
    for (const child of children) visit(child);
  };
  visit(sf);
  const out = tsText.replace(/[^\n]/g, " ").split("");
  for (const [pos, end] of ranges) {
    for (let i = pos; i < end; i++) out[i] = tsText[i];
  }
  return out.join("");
}

export function maskMarkdownCodeFences(text) {
  const lines = text.split("\n");
  let fence = null;
  return lines
    .map((line) => {
      const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence === null && m) {
        fence = m[1][0];
        return "";
      }
      if (fence !== null) {
        if (m && m[1][0] === fence) fence = null;
        return "";
      }
      return line;
    })
    .join("\n");
}

export function headingNumbersOf(markdown) {
  const nums = new Set();
  for (const line of maskMarkdownCodeFences(markdown).split("\n")) {
    const m = line.match(/^\s{0,3}#{1,6}\s+§?\s*(\d+(?:\.\d+)*)[.\s:：]/);
    if (m) nums.add(m[1]);
  }
  return nums;
}

/**
 * @param {string} file
 * @param {string} text
 * @param {ReferenceEnv} env
 * @returns {BrokenReference[]}
 */
export function findBrokenReferences(file, text, env) {
  /** @type {BrokenReference[]} */
  const broken = [];

  for (let i = text.indexOf("["); i >= 0; i = text.indexOf("[", i + 1)) {
    const link = matchMarkdownLinkAt(text, i);
    if (!link) continue;
    const url = link.url.trim().split(/\s+/)[0] ?? "";
    if (url === "" || url.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
    const pathPart = url.split("#")[0].split("?")[0];
    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      decoded = pathPart;
    }
    const resolved = resolveRepoPath(file, decoded);
    if (resolved === null || !env.exists(resolved)) {
      broken.push({
        kind: "link",
        file,
        line: lineNumberAt(text, i),
        ref: `[${link.display}](${link.url})`,
        reason:
          resolved === null
            ? `リンク先 "${pathPart}" が repo の外を指している`
            : `リンク先 "${resolved}" が存在しない（"${file}" からの相対パスとして解いた）`,
      });
    }
  }

  for (const m of text.matchAll(/ADR[\s-]?(\d{4})(?!\d)/g)) {
    if (!env.adrExists(m[1])) {
      broken.push({
        kind: "adr",
        file,
        line: lineNumberAt(text, m.index),
        ref: m[0],
        reason: `docs/decisions/${m[1]}-*.md が存在しない`,
      });
    }
  }

  for (const m of text.matchAll(/([\w./-]+\.md)\)?`?(?:\s*の)?\s*§\s*(\d+(?:\.\d+)*)/g)) {
    const target =
      [resolveRepoPath(file, m[1]), resolveRepoPath("", m[1])].find(
        (p) => p !== null && env.headingNumbers(p) !== null,
      ) ?? null;
    if (target === null) continue;
    if (!env.headingNumbers(target).has(m[2])) {
      broken.push({
        kind: "section",
        file,
        line: lineNumberAt(text, m.index),
        ref: `${m[1]} §${m[2]}`,
        reason: `"${target}" に §${m[2]} の見出し（\`## ${m[2]}.\` など）が無い`,
      });
    }
  }

  return broken;
}

export function formatBrokenReferences(broken) {
  if (broken.length === 0) return "";
  const lines = broken.map((b) => `- ${b.file}:${b.line} [${b.kind}] ${b.ref} — ${b.reason}`);
  return [
    `生きた文書の中に、指す先に届かない参照が ${broken.length} 件ある:`,
    ...lines,
    "",
    "直し方:",
    "- 生きた文書（docs/**・README・AGENTS.md・TS のコメント）は、参照を正しい先へ直す。",
    "  相対リンクは、そのファイルの置き場所からの相対パスで書く（TS のコメントは ../ の数に注意）。",
    "- ADR 番号は docs/decisions/ に在る番号を書く。§N は、指す文書に在る見出しの番号を書く。",
    "- 採用済み ADR の本文（docs/decisions/）はこの門の対象外。ADR の中の参照が誤っていたら、",
    "  本文は書き換えず、その ADR の末尾に追記で訂正を積む（docs/decisions/README.md）。",
  ].join("\n");
}
