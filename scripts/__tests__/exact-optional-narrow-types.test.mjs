import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

const narrowProbePath = join(
  root,
  "scripts",
  "__fixtures__",
  "exact-optional-narrow-types.probe.ts",
);

describe("exactOptionalPropertyTypes: 広げなかった型は undefined を受けない", () => {
  it("probe ファイルは exactOptionalPropertyTypes: true で診断0件（@ts-expect-error がすべて効いている）", () => {
    expect(render(diagnosticsOf(narrowProbePath, true))).toBe("");
  });

  it("陽性対照: exactOptionalPropertyTypes: false では、@ts-expect-error が未使用（TS2578）になる", () => {
    const codes = diagnosticsOf(narrowProbePath, false).map((d) => d.code);
    expect(codes).toContain(2578);
  });

  it("probe ファイルは存在し、4つの @ts-expect-error を持つ", () => {
    const text = readFileSync(narrowProbePath, "utf8");
    expect(text.match(/^\/\/ @ts-expect-error/gm)?.length).toBe(4);
  });
});
