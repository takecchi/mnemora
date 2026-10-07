/**
 * ⛔ 構造を解釈せず、行ごとに文字だけを見る（YAML の地の文も `run:` の中身も同じ走査で足りる）。
 * ⛔ `''` は YAML と bash で規則が違い、どちらか判定できない。黙って選ばず `unhandled` にする。
 * ⛔ ヒアドキュメントは構造を追わず、開始行を検出したら本体ごと `unhandled` にする。
 * ⛔ 依存（js-yaml 等）は足さない。依存追加はオーナー専権。
 * 🔴 `unhandled` が空でなければ、呼び出し側の歯が赤くなること（無視できない API）。
 *
 * @param {string} text
 * @returns {{ text: string, unhandled: { lineNumber: number, reason: string, line: string }[] }}
 */
export function blankOutWorkflowComments(text) {
  const lines = text.split("\n");
  /** @type {{ lineNumber: number, reason: string, line: string }[]} */
  const unhandled = [];
  /** @type {string | undefined} */
  let heredocTerminator;

  const blankedLines = lines.map((line, index) => {
    const lineNumber = index + 1;

    if (heredocTerminator !== undefined) {
      if (line.trim() === heredocTerminator) {
        heredocTerminator = undefined;
      }
      return line;
    }

    const heredocMatch =
      /<<-?\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))/.exec(
        line,
      );
    if (heredocMatch) {
      unhandled.push({
        lineNumber,
        reason: "heredoc-body-unhandled",
        line,
      });
      heredocTerminator = heredocMatch[1] ?? heredocMatch[2] ?? heredocMatch[3];
      return line;
    }

    return blankLineComment(line, lineNumber, unhandled);
  });

  if (heredocTerminator !== undefined) {
    unhandled.push({
      lineNumber: lines.length,
      reason: "heredoc-terminator-not-found",
      line: lines[lines.length - 1] ?? "",
    });
  }

  return { text: blankedLines.join("\n"), unhandled };
}

const COMMENT_START_WHITESPACE = new Set([" ", "\t"]);

/**
 * @param {string} line
 * @param {number} lineNumber
 * @param {{ lineNumber: number, reason: string, line: string }[]} unhandled
 * @returns {string}
 */
function blankLineComment(line, lineNumber, unhandled) {
  /** @type {"code" | '"' | "'"} */
  let state = "code";
  let out = "";
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (state === "code") {
      if (ch === "#" && (i === 0 || COMMENT_START_WHITESPACE.has(line[i - 1]))) {
        return out + " ".repeat(line.length - i);
      }
      if (ch === '"' || ch === "'") {
        state = ch;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === '"') {
      if (ch === "\\" && i + 1 < line.length) {
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') {
        state = "code";
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "'") {
      if (line[i + 1] === "'") {
        // `''` は YAML と bash で規則が違い、判定できない。黙って選ばず unhandled にする。
        unhandled.push({
          lineNumber,
          reason: "ambiguous-double-single-quote",
          line,
        });
        state = "code";
        out += ch;
        i += 1;
        continue;
      }
      state = "code";
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  if (state !== "code") {
    unhandled.push({
      lineNumber,
      reason: "quote-not-closed-on-same-line",
      line,
    });
    // 元の行をそのまま返す（誤って潰す実害を増やさない）。
    return line;
  }

  return out;
}
