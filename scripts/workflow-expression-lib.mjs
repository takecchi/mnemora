/**
 * **GitHub Actions の `${{ … }}` 式を、照合のためだけに正規形へ揃える**純関数
 * (Issue #163 ①)。
 *
 * ## なぜ要るか
 *
 * `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` には
 *
 * ```js
 * expect(block).toContain("name: lexical-regime-${{ matrix.serverEncoding }}");
 * ```
 *
 * という固定が在った。これは `${{` の直後と `}}` の直前の空白まで含めて**生テキストを
 * 1文字単位で**見ている。⟹ 🔴 **Actions にとって完全に同値な書き換えでも赤くなる。**
 *
 * 2026-09-13 に手で当てて実測した(Issue #163 段0 の変異 A/B 族の再現):
 *
 * | `ci.yml` の `name:` | artifact 名の実際の値 | 歯 |
 * |---|---|---|
 * | `lexical-regime-${{ matrix.serverEncoding }}` | `lexical-regime-UTF8` | ✅ 緑 |
 * | `lexical-regime-${{matrix.serverEncoding}}` | **同じ** | 🔴 **赤** |
 * | `lexical-regime-${{ format('{0}', matrix.serverEncoding) }}` | **同じ** | 🔴 **赤** |
 *
 * ⟹ **実害ゼロで赤くなる。**PR #154(「SQL の桁を揃え直しただけ」で赤くなる歯の除去)が
 * 一度直したのと同じ向きの欠陥である。
 *
 * ## 🔴 なぜ「既存の網を広げる」のではなく「照合専用の別の網を足す」のか
 *
 * `ci-yml-postgres-regime-wiring.test.mjs` には既に `${{ }}` を扱う網が在る——
 * `substituteWorkspace(text, workspace, leg)` である。⛔ **しかしあれは
 * 「summary 段を実際に `spawnSync` で走らせるために、式を本物の値へ展開する」網**であり、
 * **出力は実行されるテキスト**である。
 *
 * ⟹ そこへ「`format('{0}', X)` を `X` に戻す」「空白を詰める」を足すと、
 * **照合のためだけの変換が実行されるテキストへ漏れる**——`${{ matrix.serverEncoding }}`
 * という**実行できない文字列**が spawn される側へ混ざりうる。
 *
 * ⟹ ⭐ **だから照合専用の別の網としてここに切り出した。**
 * これは PR #181 が `if:` の暗黙の式に対して出した判断と同じ形である(逐語:
 * 「既存の `${{ }}` の網は実行されるテキストにしか当たっていない ⟹ 同じ網を広げると
 * 照合専用の変換が実行テキストへ漏れる ⟹ 照合専用の別の網を足した」)。
 *
 * ## ⭐ この関数の契約(`blankOutWorkflowComments` と同じ)
 *
 * - **戻り値は `{ text, unhandled }`。**`unhandled` は「`${{` は見つけたが正規化できな
 *   かった」断片の配列である。🔴 **呼び出し側はこれを無視できない API にしてある**——
 *   `expect(unhandled).toEqual([])` を置かないと、**この関数が将来「何も正規化しない」
 *   実装に退化しても誰も気づかない**(`blankOutWorkflowComments` の docstring と同じ理由)。
 * - **`${{ … }}` の外側は1バイトも触らない。**インデント・引用符・改行はそのまま。
 * - **正規形は `${{ <式> }}`**(内側を1つの空白で挟む)。
 *
 * ## ⚠ 何を「同値」とみなすか — いま扱っているのは2つだけ
 *
 * 1. **`${{` の直後・`}}` の直前・式の内部の空白**(単一引用符の文字列の中は除く)。
 * 2. **恒等な `format`**: `format('{0}', X)` → `X`。⚠ 置換対象が `{0}` ただ1つで、
 *    引数がちょうど1個のときだけ。`format('{0}-{1}', a, b)` や `format('x{0}', a)` は
 *    **値が変わる**ので触らない。
 *
 * ⛔ **これ以上は広げていない。**`toJSON(x)`・`fromJSON(x)`・`&&`/`||` の並べ替え・
 * 大文字小文字(Actions の関数名は大小を区別しない)は**正規化していない**——
 * ⟹ それらで書き換えられたら、この歯は**赤くなる**(安全側の誤検知)。
 * 広げるときは「本当に Actions にとって同値か」を**実測してから**にすること。
 */

/**
 * 単一引用符の文字列を跨がずに、`from` から始まる `${{` に対応する `}}` を探す。
 *
 * Actions の式では文字列リテラルは単一引用符で、`''` が引用符自身のエスケープである。
 * ⚠ `format('{0}', …)` のように**式の中に `}` が出る**ので、素朴に最初の `}}` を
 * 取ると誤る余地がある(`format('{0}}', …)` のような書き方)。⟹ 引用符を追う。
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
 * 式の中の空白を1つに詰める(単一引用符の文字列の中は1バイトも触らない)。
 *
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
 * `format('…', …)` の引数を、括弧の深さと引用符を見ながら分ける。
 *
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
 * 恒等な `format('{0}', X)` を `X` へ畳む(入れ子も畳む)。
 *
 * ⚠ **置換対象が `{0}` ただ1つで、引数がちょうど1個のときだけ。**
 * `format('{0}-{1}', a, b)` / `format('x{0}', a)` / `format('{0}{0}', a)` は
 * **値が変わる**ので触らない。
 *
 * @param {string} expr 空白を詰めたあとの式
 * @returns {string}
 */
function unwrapIdentityFormat(expr) {
  // `format` は Actions では大小を区別しないが、ここでは**正規化しない**と決めている
  // (docstring の「何を同値とみなすか」を見ること)。⟹ 小文字の `format` だけを見る。
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
 * `${{ … }}` の式だけを正規形へ揃える。**式の外側は1バイトも触らない。**
 *
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
      // `${{` は在るのに `}}` が無い。⟹ 何も変えずに残し、呼び出し側へ名乗る。
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
