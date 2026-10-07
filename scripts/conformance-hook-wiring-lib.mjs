/**
 * ⛔ 適合テストの型は、フックを必須にしない。`@mnemora/testkit` は公開済みで、必須化は公開パッケージへの
 * 破壊的変更になり、版を上げる判断はオーナーの領域。代わりに「呼び出し側がフックを渡していること」を測る。
 * 🔴 フックを渡さない呼び出し側には、条件付きの歯は `it.skip` にもならず登録すらされない。
 * ⚠ 扱っていないもの: `${…}` の中の文字列が `}` を含む場合、動的な呼び出し。
 * オブジェクト以外の引数は「読めない」として挙げる（赤）。⛔ 「読めない」を緑で通さない。
 */

/**
 * 🔴 これを通さないと、地の文のコメントがフック名を引用しているだけで「渡している」と読んでしまう。
 * ⛔ `ci-yml-postgres-regime-wiring.test.mjs` などの `blankOutComments` とは統合していない
 * （あちらは文字列を潰さないので、括弧の深さを数えられない）。
 *
 * @param {string} source
 * @returns {{ text: string, unhandled: string[] }} `unhandled` は閉じていない
 *   コメント/リテラルの断片。🔴 呼び出し側はこれを無視できない（空回りの検出点）。
 */
export function blankOutCommentsAndLiterals(source) {
  /** @type {string[]} */
  const unhandled = [];
  const out = [];
  let i = 0;
  const n = source.length;
  /** @param {number} from @param {number} to */
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      out.push(source[k] === "\n" ? "\n" : " ");
    }
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) {
        end = n;
      }
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        unhandled.push(source.slice(i, Math.min(n, i + 80)));
        blank(i, n);
        i = n;
        continue;
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findQuoteEnd(source, i + 1, ch);
      if (end === -1) {
        unhandled.push(source.slice(i, Math.min(n, i + 80)));
        blank(i, n);
        i = n;
        continue;
      }
      out.push(ch);
      blank(i + 1, end);
      out.push(ch);
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = findTemplateEnd(source, i + 1);
      if (end === -1) {
        unhandled.push(source.slice(i, Math.min(n, i + 80)));
        blank(i, n);
        i = n;
        continue;
      }
      out.push("`");
      blank(i + 1, end);
      out.push("`");
      i = end + 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return { text: out.join(""), unhandled };
}

/**
 * @param {string} s @param {number} from @param {string} quote
 * @returns {number} 閉じ引用符の位置。無ければ -1
 */
function findQuoteEnd(s, from, quote) {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === quote) {
      return i;
    }
    if (s[i] === "\n") {
      return -1;
    }
  }
  return -1;
}

/**
 * @param {string} s @param {number} from
 * @returns {number} 閉じバッククォートの位置。無ければ -1
 */
function findTemplateEnd(s, from) {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === "`") {
      return i;
    }
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") {
          depth += 1;
        } else if (s[i] === "}") {
          depth -= 1;
        }
        i += 1;
      }
      i -= 1;
    }
  }
  return -1;
}

/**
 * ⛔ `import { fnName }`・`obj.fnName(…)`・宣言そのもの（直前の語が `function`）は拾わない。
 * 定義ファイル自身を「引数が読めない呼び出し」として挙げない。
 *
 * @param {string} source コメント/リテラルを潰す前の生ソース
 * @param {string} fnName
 * @returns {{ line: number, keys: string[] | undefined }[]}
 *   `keys` が `undefined` なのは「引数がオブジェクトリテラルでない（読めない）」場合。
 */
export function findConformanceCalls(source, fnName) {
  const { text } = blankOutCommentsAndLiterals(source);
  /** @type {{ line: number, keys: string[] | undefined }[]} */
  const calls = [];
  const needle = `${fnName}(`;
  let at = text.indexOf(needle);
  while (at !== -1) {
    const before = at === 0 ? "" : text[at - 1];
    const isDeclaration = /\bfunction\s*$/.test(text.slice(Math.max(0, at - 40), at));
    if (!/[A-Za-z0-9_$.]/.test(before) && !isDeclaration) {
      const open = at + needle.length - 1;
      const close = findMatching(text, open, "(", ")");
      const line = text.slice(0, at).split("\n").length;
      if (close === -1) {
        calls.push({ line, keys: undefined });
      } else {
        calls.push({ line, keys: topLevelObjectKeys(text.slice(open + 1, close)) });
      }
    }
    at = text.indexOf(needle, at + needle.length);
  }
  return calls;
}

/**
 * @param {string} s @param {number} from 開き記号の位置
 * @param {string} openCh @param {string} closeCh
 * @returns {number} 対応する閉じ記号の位置。無ければ -1
 */
function findMatching(s, from, openCh, closeCh) {
  let depth = 0;
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === openCh) {
      depth += 1;
    } else if (s[i] === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * ⛔ 深さ1のキー位置の識別子だけを拾う。入れ子のオブジェクトの中の同名のキーを「渡している」と読まない。
 *
 * @param {string} argText
 * @returns {string[] | undefined}
 */
function topLevelObjectKeys(argText) {
  const start = argText.indexOf("{");
  if (start === -1 || argText.slice(0, start).trim() !== "") {
    return undefined;
  }
  const end = findMatching(argText, start, "{", "}");
  if (end === -1 || argText.slice(end + 1).trim() !== "") {
    return undefined;
  }
  const body = argText.slice(start + 1, end);
  /** @type {string[]} */
  const keys = [];
  let depth = 0;
  let atKeyPosition = true;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      atKeyPosition = false;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === ",") {
      atKeyPosition = true;
      continue;
    }
    if (!atKeyPosition || depth !== 0) {
      continue;
    }
    if (/\s/.test(ch)) {
      continue;
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i));
    if (match === null) {
      atKeyPosition = false;
      continue;
    }
    keys.push(match[0]);
    atKeyPosition = false;
    i += match[0].length - 1;
  }
  return keys;
}

/**
 * @param {string} source
 * @param {string} fnName
 * @param {string} hookName
 * @returns {{ line: number, reason: string }[]}
 */
export function findCallsMissingHook(source, fnName, hookName) {
  return findConformanceCalls(source, fnName).flatMap((call) => {
    if (call.keys === undefined) {
      return [
        {
          line: call.line,
          reason:
            `${fnName}(…) の引数がオブジェクトリテラルとして読めない` +
            `（変数を渡している等）。⟹ ${hookName} を渡しているか判定できないので挙げている。`,
        },
      ];
    }
    if (call.keys.includes(hookName)) {
      return [];
    }
    return [
      {
        line: call.line,
        reason: `${fnName}(…) が ${hookName} を渡していない（渡しているキー: ${call.keys.join(", ")}）。`,
      },
    ];
  });
}
