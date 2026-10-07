/**
 * ⛔ 印の無い片は1つも見ない。偽陽性が出うる母集団を「印を付けた片」に閉じるため。
 * ⛔ 片の前提の変数は {@link DOC_SNIPPET_GLOBALS} の1か所だけに置き、片の側に書き足さない。
 * ⚠ `dist` が無いと解決できない。`pnpm run build` の後に走らせること。
 */

import { posix as path } from "node:path";
import ts from "typescript";

const OPEN_FENCE_RE = /^\s*(`{3,}|~{3,})\s*(ts|typescript)\s+check\s*$/;

/**
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
 * ⛔ `any` で補わないこと。補った変数の上で片が何をしても通ってしまい、検査が噛まなくなる。
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

export const GLOBALS_HOST_DIR = "examples/chat";

/**
 * @param {string} mdPath repo からの相対パス（`/` 区切り）
 */
export function hostDirFor(mdPath) {
  const m = mdPath.match(/^(packages|examples)\/([^/]+)\//);
  if (m) return `${m[1]}/${m[2]}`;
  return GLOBALS_HOST_DIR;
}

export function virtualFileFor(mdPath, line) {
  const name = `${mdPath.replace(/[^A-Za-z0-9]+/g, "_")}__L${line}.mts`;
  return path.join(hostDirFor(mdPath), "__doc_snippet__", name);
}

/**
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
 * @param {{
 *   repoRoot: string;
 *   snippets: { file: string; line: number; code: string }[];
 *   globalsSource?: string;
 *   compilerOptions?: import("typescript").CompilerOptions;
 * }} args
 * @returns {{ file: string; line: number; diagnostics: { line: number; code: number; message: string }[] }[]}
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
