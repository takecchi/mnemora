/**
 * 文書（`*.md`）の中で**印を付けた** TypeScript のコード片を抜き出し、今の公開 API
 * （各パッケージの `exports` が指す `dist/*.d.ts`）に対してまとめて1回型検査する（ADR 0345）。
 *
 * ## 印（opt-in）
 *
 * フェンスの info string を `ts check`（または `typescript check`）にした片だけを見る。
 * GitHub の描画は info string の最初の語（`ts`）で言語を決めるので、描画は変わらない。
 * **印の無い片は1つも見ない。**わざと省略している片（`// ...省略`・シグネチャの断片・
 * 記法としての動詞の一覧）は、印を付けないだけで検査の外に出る。
 * ⟹ **偽陽性が出うる母集団は「印を付けた片」に閉じる**（ADR 0345 決定2）。
 *
 * ## 前提の変数（`runtime`・`ctx` など）
 *
 * 文書の片は、前の段落で組み立てた `runtime` や `ctx` を前提に書かれていることが多い。
 * それを補う宣言は **{@link DOC_SNIPPET_GLOBALS} の1か所だけ**に置く。片の側に書き足さない。
 * 片が自分で同じ名前を宣言・import していれば、片の側が勝つ（片はモジュールとして検査し、
 * 補う宣言は大域に置くため）。
 *
 * ## どこから解決するか
 *
 * 片はディスクに書かず、仮想ファイルとして Program に渡す。置き場所（＝モジュール解決の起点）は
 * {@link hostDirFor} が決める——`packages/<name>/` の下の文書はそのパッケージ、
 * それ以外（ルートの README・`docs/`）は `examples/chat`（`@mnemora/anthropic` 以外の
 * 公開パッケージすべてに依存する、利用者の立場の package）。
 * ⚠ **`dist` が無いと解決できない**——`pnpm run build` の後に走らせること（CI では Build の直後）。
 *
 * ## 保証しないこと
 *
 * - 型検査だけである。**実行はしない。**型が通っても、振る舞いが文書の説明どおりとは限らない。
 * - 印の付いていない片は見ない（上のとおり、それが設計である）。
 */
import { posix as path } from "node:path";
import ts from "typescript";

/** 印を付けた開きフェンス（info string が `ts check` / `typescript check`）。 */
const OPEN_FENCE_RE = /^\s*(`{3,}|~{3,})\s*(ts|typescript)\s+check\s*$/;

/**
 * 1つの Markdown から、印を付けた片を抜き出す。
 *
 * @param {string} markdown
 * @returns {{ line: number; code: string }[]} `line` は片の1行目（フェンスの次の行）の1始まりの行番号。
 */
export function extractCheckedSnippets(markdown) {
  const lines = markdown.split("\n");
  /** @type {{ line: number; code: string }[]} */
  const snippets = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (open === null) {
      const anyFence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
      if (!anyFence) continue;
      const checked = OPEN_FENCE_RE.test(line);
      open = { indent: anyFence[1], fence: anyFence[2], checked, start: i + 1, body: [] };
      continue;
    }
    const close = line.match(/^(\s*)(`{3,}|~{3,})\s*$/);
    if (close && close[2][0] === open.fence[0] && close[2].length >= open.fence.length) {
      if (open.checked) {
        const code = open.body
          .map((l) => (l.startsWith(open.indent) ? l.slice(open.indent.length) : l))
          .join("\n");
        snippets.push({ line: open.start + 1, code });
      }
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return snippets;
}

/**
 * 片の前提になっている変数の宣言。**ここが唯一の置き場所である**（ADR 0345 決定3）。
 *
 * - 大域の宣言（script）として置くので、片が同じ名前を自分で宣言・import すれば片の側が勝つ。
 * - 型は `import("…")` で引く。解決の起点は `examples/chat`（{@link GLOBALS_HOST_DIR}）。
 * - ⛔ `any` で補わないこと。補った変数の上で片が何をしても通ってしまい、検査が噛まなくなる。
 */
export const DOC_SNIPPET_GLOBALS = `// 文書のコード片が前提にしている変数（scripts/check-doc-snippets-lib.mjs、ADR 0345）。
declare const runtime: import("@mnemora/core").Runtime;
declare const ctx: import("@mnemora/core").Ctx;
declare const input: import("@mnemora/core").ObserveInput;
declare const transcript: string;
declare const correctionMemoryId: import("@mnemora/core").MemoryId;
declare const embeddingProvider: import("@mnemora/local-embedding").LocalEmbeddingProvider;
declare const provider: import("@mnemora/local-embedding").LocalEmbeddingProvider;
declare const veryLongText: string;
declare const LocalEmbeddingProvider: typeof import("@mnemora/local-embedding").LocalEmbeddingProvider;
declare const omission: import("@mnemora/core").FilteredOmission;
declare const MyTenantSettingsStore: new () => import("@mnemora/core").TenantSettingsStore;
`;

/** 大域の宣言の置き場所（repo からの相対）。 */
export const GLOBALS_HOST_DIR = "examples/chat";

/**
 * 文書の片をどこから解決するか（repo からの相対のディレクトリ）。
 *
 * @param {string} mdPath repo からの相対パス（`/` 区切り）
 */
export function hostDirFor(mdPath) {
  const m = mdPath.match(/^(packages|examples)\/([^/]+)\//);
  if (m) return `${m[1]}/${m[2]}`;
  return GLOBALS_HOST_DIR;
}

/** 片1つぶんの仮想ファイル名（repo からの相対）。`.mts` にして常に ESM として読ませる。 */
export function virtualFileFor(mdPath, line) {
  const name = `${mdPath.replace(/[^A-Za-z0-9]+/g, "_")}__L${line}.mts`;
  return path.join(hostDirFor(mdPath), "__doc_snippet__", name);
}

/**
 * `tsconfig.base.json` の compilerOptions を、検査用に読み替える。
 *
 * @param {string} repoRoot
 */
export function loadCompilerOptions(repoRoot) {
  const configPath = path.join(repoRoot, "tsconfig.base.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    read.config.compilerOptions ?? {},
    repoRoot,
  );
  if (errors.length > 0) {
    throw new Error(
      errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n"),
    );
  }
  return {
    ...options,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    types: ["node"],
  };
}

/**
 * 片をまとめて1つの Program で型検査する。
 *
 * @param {{
 *   repoRoot: string;
 *   snippets: { file: string; line: number; code: string }[];
 *   globalsSource?: string;
 *   compilerOptions?: import("typescript").CompilerOptions;
 * }} args
 * @returns {{ file: string; line: number; diagnostics: { line: number; code: number; message: string }[] }[]}
 *   `diagnostics[].line` は **Markdown の中の行番号**に読み替えてある。
 */
export function checkSnippets({
  repoRoot,
  snippets,
  globalsSource = DOC_SNIPPET_GLOBALS,
  compilerOptions,
}) {
  const options = compilerOptions ?? loadCompilerOptions(repoRoot);
  /** @type {Map<string, string>} */
  const virtual = new Map();
  const globalsPath = path.join(repoRoot, GLOBALS_HOST_DIR, "__doc_snippet__", "globals.d.ts");
  virtual.set(globalsPath, globalsSource);
  const entries = snippets.map((s) => {
    const fileName = path.join(repoRoot, virtualFileFor(s.file, s.line));
    // `export {}` で必ずモジュールにする（片の宣言が大域の宣言と衝突しないように）。
    virtual.set(fileName, `${s.code}\nexport {};\n`);
    return { ...s, fileName };
  });

  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getCurrentDirectory = () => repoRoot;
  host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(f);
    if (text !== undefined) return ts.createSourceFile(f, text, languageVersion, true);
    return getSourceFile.call(host, f, languageVersion, onError, shouldCreate);
  };

  const program = ts.createProgram({
    rootNames: [globalsPath, ...entries.map((e) => e.fileName)],
    options,
    host,
  });

  const globalDiagnostics = ts
    .getPreEmitDiagnostics(program, program.getSourceFile(globalsPath))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  if (globalsSource && globalDiagnostics.length > 0) {
    throw new Error(
      `前提の変数の宣言（DOC_SNIPPET_GLOBALS）自体が型検査に通らない:\n${globalDiagnostics.join("\n")}`,
    );
  }

  return entries.map((e) => {
    const sf = program.getSourceFile(e.fileName);
    const diagnostics = [
      ...program.getSyntacticDiagnostics(sf),
      ...program.getSemanticDiagnostics(sf),
    ].map((d) => {
      const pos = d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line;
      return {
        line: e.line + pos,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      };
    });
    return { file: e.file, line: e.line, diagnostics };
  });
}
