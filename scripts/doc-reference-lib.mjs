import ts from "typescript";
import { lineNumberAt } from "./adr-citation-lib.mjs";
import { matchMarkdownLinkAt } from "./markdown-link-lib.mjs";

/**
 * 生きた文書の中の参照が、指す先に届くかを検査する純関数の側（PR #1118 の続き。
 * `scripts/adr-citation-lib.mjs` と同じ分担——ファイル I/O を持たない。呼び出す側
 * `scripts/__tests__/doc-reference.test.mjs` がファイルを読み、存在の問い合わせを `env` で渡す）。
 *
 * ## 検査する3つの形（門）
 *
 * 1. **相対リンク** `[表示](相対パス)`: 指す先のファイル（またはディレクトリ）が在ること。
 *    `http:` などのスキームで始まるもの・`#` だけのもの（同じ文書の中のアンカー）は見ない。
 *    `#アンカー` と `?…` は落としてからパスだけを見る——**アンカーの存在は見ない**
 *    （GitHub の見出しスラグの規則を正確に写せる保証が無いため。PR #1118）。
 * 2. **`ADR NNNN`**: `docs/decisions/NNNN-*.md` が在ること。
 * 3. **`<file>.md §N`**（`docs/recall.md §7`・`[recall.md](./recall.md) §7` の形）: 指す先の
 *    文書に、番号 N の見出し（`## 7.`・`### 7.2` など）が在ること。指す先のファイルが
 *    解決できない場合は、この形では見ない（リンクなら 1. が拾う）。
 *
 * ## 見ないもの（門にしない。PR #1118 の判断）
 * アンカー・Issue / PR 番号・`file:line`・ADR 本文（`docs/decisions/`）・文書を名指ししない
 * 裸の `§N`。一覧を出すだけの警告も置かない（読まれずに腐るため）。
 *
 * ## 生きた文書の範囲（呼び出す側が決める）
 * `docs/**`（`docs/decisions/` を除く）・各 `README.md`・`AGENTS.md`・`packages/*\/src` の TS の
 * **コメントの中だけ**。TS はコメントの外（正規表現・文字列）に `[…](…)` の形が現れうるので、
 * `commentTextOf` でコメント以外を空白に潰してから渡す。markdown はコードブロック
 * （```` ``` ```` / `~~~`）の中を空白に潰してから渡す（`maskMarkdownCodeFences`）。
 * どちらも改行は残すので、行番号は元の文書と一致する。
 */

/**
 * @typedef {object} ReferenceEnv
 * @property {(repoRelativePath: string) => boolean} exists  ファイルかディレクトリが在るか
 * @property {(adrNumber: string) => boolean} adrExists  `docs/decisions/NNNN-*.md` が在るか
 * @property {(repoRelativePath: string) => Set<string> | null} headingNumbers
 *   その文書の見出しの番号の集合（`## 7.` → `"7"`、`### 7.2` → `"7.2"`）。文書が無ければ `null`
 */

/**
 * @typedef {object} BrokenReference
 * @property {"link" | "adr" | "section"} kind
 * @property {string} file   検査した文書（repo 直下からの相対パス）
 * @property {number} line   1始まりの行番号
 * @property {string} ref    文書に書かれている参照そのもの
 * @property {string} reason なぜ落ちたか
 */

/** repo 直下からの相対パスを、`/` 区切り・`..` を解いた形にする（repo の外へ出たら `null`）。 */
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

/**
 * TS のソースから、コメントの中だけを残す（コメント以外は、改行を残して空白に潰す）。
 * 正規表現・文字列・テンプレートの中の `//`・`[…](…)` をコメントと取り違えないよう、
 * TypeScript のパーサで字句の境目を取り、各字句の前後のコメントの範囲を集める。
 */
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

/** markdown のコードブロックの中を、改行を残して空白に潰す。 */
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

/**
 * 見出しの番号の集合を取る（コードブロックの中は見ない）。`## 7. 題` / `### 7.2 題` /
 * `## §7 題` の形。
 */
export function headingNumbersOf(markdown) {
  const nums = new Set();
  for (const line of maskMarkdownCodeFences(markdown).split("\n")) {
    const m = line.match(/^\s{0,3}#{1,6}\s+§?\s*(\d+(?:\.\d+)*)[.\s:：]/);
    if (m) nums.add(m[1]);
  }
  return nums;
}

/**
 * `file` の本文 `text`（呼び出す側で、見ない部分を空白に潰したもの）の中の、壊れた参照を
 * 全部返す。
 *
 * @param {string} file  repo 直下からの相対パス
 * @param {string} text
 * @param {ReferenceEnv} env
 * @returns {BrokenReference[]}
 */
export function findBrokenReferences(file, text, env) {
  /** @type {BrokenReference[]} */
  const broken = [];

  // 1. 相対リンク
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

  // 2. ADR NNNN
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

  // 3. <file>.md §N
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

/** 赤になったときに出す、1件1行の報告と、直し方。 */
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
