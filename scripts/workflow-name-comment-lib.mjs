/**
 * ⚠ 全角文字は YAML の空白ではない。`#` の直前が全角の `（` ならコメントは始まらない。
 * 「`#` が在るか」だけを見る歯はここを誤検出するので、`classifyPlainScalarValue` は
 * 半角スペース/タブだけを「コメントを始める空白」として扱う。
 *
 * 🔴 扱えない形(block scalar・flow mapping・同じ行で閉じない引用符・空の inline 値)は、
 * 黙って安全側へ倒さず `status: "unhandled"` を返す。呼び出し側はこれを「安全」として無視しないこと。
 *
 * ⚠ この歯のために YAML パーサの依存は足さない(`docs/autonomy.md`、ADR 0014/0061)。
 * 実装は自前の文字列解析なので、扱えない形の外では自信を持てない。壊れたときは、対象の形が増えたのなら
 * unhandled の種類を足すこと。歯を消さない・黙って safe 側へ倒さない。
 */

const COMMENT_START_WHITESPACE = new Set([" ", "\t"]);

/**
 * ⚠ 正規表現は「行頭の空白 + 任意で `- ` + `name:`」だけを見て、YAML の構造は見ない。
 * 測りたいのは値が黙って切れるかどうかで、どの階層の `name:` かは無関係なため。
 * 🔴 `run: |` の block scalar の中で行頭が `name:` の行は、キーと誤って拾う。
 * 見つかったらここに `run:` ブロックの追跡を足すこと。
 *
 * @param {string} yamlText
 * @returns {{ lineNumber: number, indent: number, isStep: boolean, rawLine: string, value: string }[]}
 */
export function findNameDeclarations(yamlText) {
  const lines = yamlText.split("\n");
  const NAME_KEY_PATTERN = /^(\s*)(-\s+)?name:(.*)$/;
  /** @type {{ lineNumber: number, indent: number, isStep: boolean, rawLine: string, value: string }[]} */
  const declarations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const matched = NAME_KEY_PATTERN.exec(line);
    if (!matched) {
      continue;
    }
    const [, indent, dash, rest] = matched;
    const value = rest.startsWith(" ") ? rest.slice(1) : rest;
    declarations.push({
      lineNumber: i + 1,
      indent: indent.length,
      isStep: Boolean(dash),
      rawLine: line,
      value,
    });
  }
  return declarations;
}

/**
 * @param {string} value `"` または `'` から始まる文字列(name: の右辺そのもの)
 * @param {'"' | "'"} quoteChar
 * @returns {{ status: "safe" | "unhandled", reason: string }}
 */
function classifyQuotedValue(value, quoteChar) {
  let i = 1;
  while (i < value.length) {
    const ch = value[i];
    if (quoteChar === '"' && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quoteChar) {
      if (quoteChar === "'" && value[i + 1] === "'") {
        i += 2;
        continue;
      }
      return { status: "safe", reason: "quoted-closed-on-same-line" };
    }
    i += 1;
  }
  return { status: "unhandled", reason: "quoted-not-closed-on-same-line" };
}

/**
 * @param {string} value
 * @returns {{ status: "safe" | "truncated", reason: string, cutAt?: number, kept?: string }}
 */
function classifyPlainScalarValue(value) {
  if (value.length > 0 && value[0] === "#") {
    return { status: "truncated", reason: "value-starts-with-comment-marker", cutAt: 0, kept: "" };
  }
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === "#" && COMMENT_START_WHITESPACE.has(value[i - 1])) {
      return {
        status: "truncated",
        reason: "comment-marker-inside-unquoted-value",
        cutAt: i,
        kept: value.slice(0, i).replace(/[ \t]+$/, ""),
      };
    }
  }
  return { status: "safe", reason: "plain-scalar-no-comment-marker" };
}

/**
 * @param {string} value
 * @returns {{ status: "safe" | "truncated" | "unhandled", reason: string, cutAt?: number, kept?: string }}
 */
export function classifyNameValue(value) {
  if (value.trim() === "") {
    return { status: "unhandled", reason: "empty-inline-value" };
  }
  if (value.startsWith("|") || value.startsWith(">")) {
    return { status: "unhandled", reason: "block-scalar" };
  }
  if (value.startsWith("{")) {
    return { status: "unhandled", reason: "flow-mapping" };
  }
  if (value.startsWith('"')) {
    return classifyQuotedValue(value, '"');
  }
  if (value.startsWith("'")) {
    return classifyQuotedValue(value, "'");
  }
  return classifyPlainScalarValue(value);
}

/**
 * @param {string} yamlText
 * @param {string} [fileLabel] エラーメッセージに出すファイル名(複数ファイルを
 *   まとめて扱う呼び出し側のため)。
 * @returns {{ lineNumber: number, indent: number, isStep: boolean, rawLine: string, value: string,
 *   status: "safe" | "truncated" | "unhandled", reason: string, cutAt?: number, kept?: string,
 *   fileLabel?: string }[]}
 */
export function analyzeWorkflowNames(yamlText, fileLabel) {
  return findNameDeclarations(yamlText).map((decl) => ({
    ...decl,
    fileLabel,
    ...classifyNameValue(decl.value),
  }));
}
