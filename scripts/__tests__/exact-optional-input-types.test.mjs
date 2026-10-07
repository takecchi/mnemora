/**
 * src の内部の型エラーは見ない（src 自身は `exactOptionalPropertyTypes: false` で書かれている）。診断を数えるのは probe ファイルだけ。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const probePath = join(root, "scripts", "__fixtures__", "exact-optional-input-types.probe.ts");

const PACKAGES = [
  "core",
  "testkit",
  "postgres",
  "openai",
  "anthropic",
  "local-embedding",
  "bullmq",
];

function compilerOptions(exact) {
  const paths = {};
  for (const name of PACKAGES)
    paths[`@mnemora/${name}`] = [join(root, "packages", name, "src", "index.ts")];
  paths["@mnemora/testkit/fixtures"] = [join(root, "packages", "testkit", "src", "fixtures.ts")];
  return {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: exact,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
    typeRoots: [join(root, "node_modules", "@types")],
    baseUrl: root,
    paths,
  };
}

function diagnosticsOf(file, exact) {
  const program = ts.createProgram([file], compilerOptions(exact));
  const source = program.getSourceFile(file);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
}

function render(diagnostics) {
  return diagnostics
    .map((d) => {
      const pos =
        d.file && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start)
          : { line: 0, character: 0 };
      return `${d.file?.fileName ?? "?"}:${pos.line + 1}:${pos.character + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    })
    .join("\n");
}

describe("exactOptionalPropertyTypes: 入力側の公開型", () => {
  it("probe ファイルは exactOptionalPropertyTypes: true で診断0件", () => {
    const diagnostics = diagnosticsOf(probePath, true);
    expect(render(diagnostics)).toBe("");
  });

  it("陽性対照: exactOptionalPropertyTypes: true が効いていれば、既知の赤い行が TS2375 になる", () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemora-exact-optional-"));
    try {
      const file = join(dir, "control.ts");
      writeFileSync(file, "export const _x: { a?: string } = { a: undefined };\n");
      expect(diagnosticsOf(file, true).map((d) => d.code)).toContain(2375);
      expect(diagnosticsOf(file, false)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probe ファイルは存在し、`_callSites` を含む（空のファイルで緑にならない）", () => {
    expect(readFileSync(probePath, "utf8")).toContain("_callSites");
  });
});
