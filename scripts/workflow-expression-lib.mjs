/**
 * ⛔ 照合専用の別の網として切り出している。既存の `substituteWorkspace`(summary 段を実際に走らせるために
 * 式を本物の値へ展開する網)に「`format('{0}', X)` を `X` に戻す」「空白を詰める」を足すと、
 * 照合のためだけの変換が実行されるテキストへ漏れる。
 *
 * 契約は `{ text, unhandled }`。`unhandled` は「`${{` は見つけたが正規化できなかった」断片で、
 * 🔴 呼び出し側が無視できない API にしてある。`expect(unhandled).toEqual([])` を置かないと、
 * 何も正規化しない実装に退化しても誰も気づかない。`${{ … }}` の外側は1バイトも触らない。
 *
 * ⛔ 同値とみなすのは次の2つだけで、これ以上は広げない。
 * 1. `${{` の直後・`}}` の直前・式の内部の空白(単一引用符の文字列の中は除く)。
 * 2. 恒等な `format('{0}', X)` → `X`。置換対象が `{0}` ただ1つで引数が1個のときだけ。
 * `toJSON`・`fromJSON`・`&&`/`||` の並べ替え・大文字小文字は正規化しないので、それらで書き換えられたら歯は赤くなる
 * (安全側の誤検知)。広げるときは、本当に Actions にとって同値かを実測してからにすること。
 */

/**
 * ⚠ 式の中に `}` が出る(`format('{0}}', …)`)ので、素朴に最初の `}}` を取らず、単一引用符を追う。
 *
 * @param {string} text
 * @param {number} from `${{` の直後の位置
 * @returns {{ end: number, inner: string } | undefined} 見つからなければ undefined
 */
function findExpressionEnd(text, from) {
  let inQuote = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 1;
          continue;
        }
        inQuote = false;
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      continue;
    }
    if (ch === "}" && text[i + 1] === "}") {
      return { end: i, inner: text.slice(from, i) };
    }
  }
  return undefined;
}

/**
 * @param {string} expr
 * @returns {string | undefined} 引用符が閉じていなければ undefined
 */
function collapseWhitespace(expr) {
  let out = "";
  let inQuote = false;
  let pendingSpace = false;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (inQuote) {
      out += ch;
      if (ch === "'") {
        if (expr[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        inQuote = false;
      }
      continue;
    }
    if (ch === "'") {
      if (pendingSpace && out !== "") {
        out += " ";
      }
      pendingSpace = false;
      out += ch;
      inQuote = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out !== "") {
      out += " ";
    }
    pendingSpace = false;
    out += ch;
  }
  if (inQuote) {
    return undefined;
  }
  return out;
}

/**
 * @param {string} argsText
 * @returns {string[] | undefined} 引用符/括弧が閉じていなければ undefined
 */
function splitArguments(argsText) {
  /** @type {string[]} */
  const args = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i];
    if (inQuote) {
      current += ch;
      if (ch === "'") {
        if (argsText[i + 1] === "'") {
          current += "'";
          i += 1;
          continue;
        }
        inQuote = false;
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (inQuote || depth !== 0) {
    return undefined;
  }
  args.push(current.trim());
  return args;
}

/**
 * ⚠ 置換対象が `{0}` ただ1つで、引数がちょうど1個のときだけ。`format('{0}-{1}', a, b)` 等は値が変わるので触らない。
 *
 * @param {string} expr 空白を詰めたあとの式
 * @returns {string}
 */
function unwrapIdentityFormat(expr) {
  // 小文字の `format` だけを見る。Actions は大小を区別しないが、正規化しないと決めている。
  if (!expr.startsWith("format(") || !expr.endsWith(")")) {
    return expr;
  }
  const args = splitArguments(expr.slice("format(".length, -1));
  if (args === undefined || args.length !== 2) {
    return expr;
  }
  if (args[0] !== "'{0}'") {
    return expr;
  }
  return unwrapIdentityFormat(args[1]);
}

/**
 * @param {string} text
 * @returns {{ text: string, unhandled: string[] }}
 */
export function normalizeWorkflowExpressions(text) {
  /** @type {string[]} */
  const unhandled = [];
  let out = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("${{", cursor);
    if (open === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, open);
    const found = findExpressionEnd(text, open + 3);
    if (found === undefined) {
      // `}}` が無いときは何も変えずに残し、呼び出し側へ名乗る。
      unhandled.push(text.slice(open, Math.min(text.length, open + 80)));
      out += text.slice(open);
      break;
    }
    const collapsed = collapseWhitespace(found.inner);
    if (collapsed === undefined) {
      unhandled.push(text.slice(open, found.end + 2));
      out += text.slice(open, found.end + 2);
    } else {
      out += `\${{ ${unwrapIdentityFormat(collapsed)} }}`;
    }
    cursor = found.end + 2;
  }
  return { text: out, unhandled };
}
