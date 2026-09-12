import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`examples/chat/src` 配下で `createExampleRuntime(...)` を呼んでいる箇所のうち、
 * env リテラルに `MNEMORA_EMBEDDING: "local"` を含むものは、必ず同じリテラルで
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を運んでいること**(Issue #164 の続き)。
 *
 * 🔑 **なぜ要るか**: `scripts/__tests__/ci-yml-local-embedding-cache-wiring.test.mjs` は
 * `.github/workflows/ci.yml` の `actions/cache` の `path:` と job-level env
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` の対だけを測っていた。しかし**その env が
 * `LocalEmbeddingProvider` まで実際に届くか**は別の問題であり、`ci.yml` の歯は
 * 一貫して緑のまま、`examples/chat/src/__tests__/consolidation-cost.postgres.test.ts`
 * の1本が `createExampleRuntime(requireDatabaseUrl(), { MNEMORA_LLM: "deterministic",
 * MNEMORA_EMBEDDING: "local" })` とリテラルの env オブジェクトだけを渡していたため、
 * CI の `actions/cache` が設定した job-level env が届かず、
 * `cacheDir=未指定（既定の場所）` のまま transformers.js の既定パスへ落ち、
 * `actions/cache` の `path:` の外で毎回 Hugging Face を素で叩いて 429 を踏んだ
 * (run 34704804772)。⟹ **`path:` ↔ env の対だけでなく、env ↔ 呼び出し側まで
 * 追う歯が要る。**
 *
 * ⭐ **`actions/cache` は4ジョブとも hit していた**(`Cache restored successfully` /
 * `Cache Size: ~27 MB`)。⟹ **「キャッシュが在る」は「キャッシュが効いている」の
 * 証拠にならない。**復元先は正しかったが、読む側がそこを見ていなかった。
 *
 * ## 何を測っているか
 *
 * 1. `examples/chat/src` 配下のすべての `.ts` を読み、コメントを潰してから、
 *    `createExampleRuntime(` の呼び出しをすべて拾う。
 * 2. 呼び出しの第2引数(env リテラル)が `MNEMORA_EMBEDDING: "local"` を含むものを
 *    **対象**とする。
 * 3. 対象それぞれについて、同じ引数リテラルが次のいずれかで
 *    `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を運んでいることを測る:
 *    - `...process.env`(丸ごと展開)
 *    - `...localEmbeddingCacheDirEnv(...)`(このヘルパの展開)
 *    - `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR: ...`(明示のキー)
 *
 * 🔴 **走査の前に TS のコメントを潰す。** 潰さないと、地の文のコメント
 * (`providers.ts` の docstring 等)が `MNEMORA_EMBEDDING: "local"` を**引用している
 * だけ**で一致してしまう——`ci-yml-local-embedding-cache-wiring.test.mjs` が
 * `blankOutWorkflowComments` で踏んだのと同じ形の欠陥(PR #161)。⚠ 実際に
 * `providers.ts` の docstring と `providers.test.ts` の文字列リテラルが
 * `MNEMORA_EMBEDDING: "local"` を含んでいる。
 *
 * ⚠ **空回り防止**: 対象の件数を `toBeGreaterThanOrEqual(3)` で下限だけ固定する
 * (`toBe` にしない——今後4本目・5本目が増えても赤くならないように)。
 *
 * ⚠ **分類できなかった呼び出しは黙って捨てず `unhandled` に集める。** 括弧の対応が
 * 崩れて引数の終わりを機械的に決められなかった場合など。`expect(unhandled).toEqual([])`
 * で必ず見る(`ci-yml-*-wiring.test.mjs` と同じ配線)。
 *
 * ## 確かめていないこと
 *
 * - **`localEmbeddingCacheDirEnv()` 自身が実際に値を運ぶか**は別の歯
 *   (`examples/chat/src/__tests__/providers.test.ts` の
 *   `describe("localEmbeddingCacheDirEnv …")`)で見ている。この歯は
 *   「呼んでいるかどうか」という配線だけを見ており、`localEmbeddingCacheDirEnv()` の
 *   中身が正しいことまでは保証しない。
 * - **CI 上で実際にキャッシュが当たるか**は測っていない(静的な走査であり、
 *   実行時の cache hit/miss は CI の実行結果でしか分からない)。
 * - **`...process.env` の*後*に個別のキーで上書きしていないこと**は確認していない。
 *   ⟹ `...process.env, MNEMORA_LOCAL_EMBEDDING_CACHE_DIR: undefined` のような形を
 *   足しても、この歯は(誤って)緑のままである。
 * - **YAML/CI 側の `path:` ↔ env の対**は別の歯
 *   (`ci-yml-local-embedding-cache-wiring.test.mjs`)が見ている。この歯はその先
 *   (env ↔ 呼び出し側)だけを見る。
 * - ⚠ **テンプレートリテラルの `${...}` の中の丸括弧**までは特別扱いしていない。
 *   今回の対象コードには無いが、将来そこに丸括弧を含む式が現れたら括弧の対応が
 *   ずれる可能性がある。壊れたときは「配線が変わった」のか「書き方が変わった」のかを
 *   見て、配線が変わっていないなら取り出し方のほうを直すこと(**歯を消さないこと**)。
 */

const exampleChatSrcDir = fileURLToPath(new URL("../../examples/chat/src", import.meta.url));

/** `dir` 以下を再帰的に歩き、`.ts` ファイルのパスを集める。 */
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
 * TS のソースから**コメントだけ**を空白へ潰す(改行は残す。1文字を消費したら
 * 必ず1文字を出すので、元のソースと添字が一致する)。
 *
 * `ci-yml-postgres-regime-wiring.test.mjs` の `blankOutComments` と同じアルゴリズム
 * (行コメントとブロックコメントを潰し、文字列・テンプレートリテラルの中身は潰さない)。
 * 正規表現リテラルの中の `//` は見分けていない——この歯が読む対象
 * (`createExampleRuntime` 呼び出し周辺)には出てこない。
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
    // 文字列の中: エスケープを1組として読み飛ばし、同じ引用符で閉じる。
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
 * `text[openParenIndex]` が `(` であることを前提に、対応する閉じ括弧の添字を返す。
 * 文字列・テンプレートリテラルの中の丸括弧は数えない。見つからなければ -1。
 *
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
 * 呼び出しの引数リストを、トップレベルの `,` で分割する。
 * 波括弧・角括弧・丸括弧・文字列リテラルの中の `,` は分割点にしない。
 *
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
 * 1ファイル分のソース(コメント潰し済み)から `createExampleRuntime(...)` の呼び出しを
 * すべて拾い、それぞれについて「第2引数(env リテラル)のテキスト」を返す。
 * 引数が1つしかない呼び出しは `argsText: undefined` になる
 * (`MNEMORA_EMBEDDING` を渡していない=対象外であり、これ自体は unhandled ではない)。
 *
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
      // env を渡していない呼び出し(既定の provider mode を使う)。
      // MNEMORA_EMBEDDING を名乗りようがないので対象外。
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
    // ⛔ `toBe` にしない: 呼び出しが4件目・5件目に増えても赤くならないように。
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
