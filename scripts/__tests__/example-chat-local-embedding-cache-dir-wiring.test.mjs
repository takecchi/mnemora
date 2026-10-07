import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 走査の前に TS のコメントを潰す（`providers.ts` の docstring などが `MNEMORA_EMBEDDING: "local"` を引用しているだけで一致するため）。
 */

const exampleChatSrcDir = fileURLToPath(new URL("../../examples/chat/src", import.meta.url));

function findTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 正規表現リテラルの中の `//` は見分けない。
 *
 * @param {string} source
 * @returns {string}
 */
function blankOutComments(source) {
  let out = "";
  let state = "code";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        state = ch;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
        i += 1;
        continue;
      }
      out += " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (ch === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === state) {
      state = "code";
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} openParenIndex
 * @returns {number}
 */
function findMatchingParen(text, openParenIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openParenIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * @param {string} argsText
 * @returns {string[]}
 */
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i];
    if (quote !== null) {
      current += ch;
      if (ch === "\\") {
        i += 1;
        current += argsText[i] ?? "";
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") {
    args.push(current);
  }
  return args;
}

const CALL_MARKER = "createExampleRuntime(";
const EMBEDDING_LOCAL_PATTERN = /MNEMORA_EMBEDDING\s*:\s*"local"/;
const CARRIES_CACHE_DIR_PATTERNS = [
  /\.\.\.process\.env/,
  /\.\.\.localEmbeddingCacheDirEnv\s*\(/,
  /MNEMORA_LOCAL_EMBEDDING_CACHE_DIR\s*:/,
];

/**
 * @param {string} blanked
 * @param {string} file
 */
function extractCalls(blanked, file) {
  const calls = [];
  const unhandled = [];
  let searchFrom = 0;
  for (;;) {
    const markerIndex = blanked.indexOf(CALL_MARKER, searchFrom);
    if (markerIndex === -1) {
      break;
    }
    const openParenIndex = markerIndex + CALL_MARKER.length - 1;
    const lineNumber = blanked.slice(0, markerIndex).split("\n").length;
    const closeParenIndex = findMatchingParen(blanked, openParenIndex);
    if (closeParenIndex === -1) {
      unhandled.push({ file, line: lineNumber, reason: "unmatched-paren" });
      searchFrom = openParenIndex + 1;
      continue;
    }
    const argsText = blanked.slice(openParenIndex + 1, closeParenIndex);
    const topLevelArgs = splitTopLevelArgs(argsText);
    calls.push({ line: lineNumber, argsText: topLevelArgs[1] });
    searchFrom = closeParenIndex + 1;
  }
  return { calls, unhandled };
}

const tsFiles = findTsFiles(exampleChatSrcDir).sort();

/** @type {{ file: string, line: number, argsText: string }[]} */
const targets = [];
/** @type {{ file: string, line: number, reason: string }[]} */
const unhandled = [];

for (const file of tsFiles) {
  const raw = readFileSync(file, "utf8");
  const blanked = blankOutComments(raw);
  const { calls, unhandled: fileUnhandled } = extractCalls(blanked, file);
  unhandled.push(...fileUnhandled);
  for (const call of calls) {
    if (call.argsText === undefined) {
      continue;
    }
    if (!EMBEDDING_LOCAL_PATTERN.test(call.argsText)) {
      continue;
    }
    targets.push({ file, line: call.line, argsText: call.argsText });
  }
}

describe("examples/chat: createExampleRuntime(local embedding) の env 配線(Issue #164 続き)", () => {
  it("ファイルが1本以上見つかる(findTsFiles の土台が崩れていない)", () => {
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  it("🔴 コメント潰しが「拾えない」呼び出しに当たっていない(unhandled が空)", () => {
    expect(unhandled).toEqual([]);
  });

  it('⚠ MNEMORA_EMBEDDING: "local" を渡す createExampleRuntime(...) 呼び出しが最低3件見つかる(空回り防止。本数はハードコードしない)', () => {
    // `toBe` にしない（呼び出しが増えても赤くならないように）。
    expect(
      targets.length,
      "検出できた呼び出し: " + targets.map((t) => `${t.file}:${t.line}`).join(", "),
    ).toBeGreaterThanOrEqual(3);
  });

  it("⭐ その全てが MNEMORA_LOCAL_EMBEDDING_CACHE_DIR を(...process.env / ...localEmbeddingCacheDirEnv() / 明示のキーのいずれかで)運んでいる", () => {
    for (const target of targets) {
      const carries = CARRIES_CACHE_DIR_PATTERNS.some((pattern) => pattern.test(target.argsText));
      expect(
        carries,
        `${target.file}:${target.line}: MNEMORA_EMBEDDING: "local" を渡しているが ` +
          "MNEMORA_LOCAL_EMBEDDING_CACHE_DIR を運んでいない" +
          `(argsText: ${JSON.stringify(target.argsText)})`,
      ).toBe(true);
    }
  });
});
