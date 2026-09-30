import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * docs/architecture.md §3.6: 「core が実行時に依存してよいのは zod だけである」
 * 「これは方針ではなく機械的に担保する」——このテストがその機械的な担保にあたる。
 * 歯は2本ある:
 *
 * 1. package.json の `dependencies` のキーが ['zod'] だけであること。
 * 2. `src`（テストを除く）が **実行時に** import するものが、`zod`・相対パス・`node:` 組み込みだけであること。
 *    1 だけでは、devDependency（vitest や typescript）を src から import しても全検査が緑のまま
 *    dist に出る（型検査・lint・build は通る）。
 *
 * 2 は各 src を `ts.transpileModule` で JS にしてから見る。`import type` や、型としてしか使わない
 * import は tsc の出力から消える（verbatimModuleSyntax: false）ため、**dist に実際に残る import** と
 * 同じ集合を、build より前（CI では test が build より先に走る）に得られる。文字列の正規表現ではなく
 * AST で見るので、`export ... from`・動的 `import()`・`require()` も拾う。
 *
 * node script でもよいと指示されているが、CI の `test` ステップで必ず走らせるため
 * vitest のテストとして書く。パッケージは CommonJS 出力のため `import.meta.url` ではなく
 * `__dirname` を使う。
 */
const packageRoot = join(__dirname, "../..");
const packageJsonPath = join(packageRoot, "package.json");
const srcRoot = join(packageRoot, "src");

function readPackageJson(): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(packageJsonPath, "utf-8"));
}

/** テスト（`__tests__/` と `*.test.ts`）を除く src の .ts を列挙する。 */
function listRuntimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      out.push(...listRuntimeSources(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** 実行時に読み込まれる module specifier を、transpile 後の JS から全部取る。 */
export function runtimeSpecifiers(source: string): string[] {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: false,
      isolatedModules: true,
    },
  }).outputText;
  const sf = ts.createSourceFile("out.js", js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteralLike(n.moduleSpecifier)
    ) {
      found.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n)) {
      const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const arg = n.arguments[0];
        // 文字列リテラルでない specifier は静的に判定できない——許可リストに載らない印で返す。
        found.push(arg && ts.isStringLiteralLike(arg) ? arg.text : "<non-literal specifier>");
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function isAllowedRuntimeSpecifier(spec: string): boolean {
  return (
    spec === "zod" ||
    spec.startsWith("zod/") ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("node:")
  );
}

describe("packages/core の依存境界（docs/architecture.md §3.6）", () => {
  it("dependencies のキーは ['zod'] のみである", () => {
    const pkg = readPackageJson();
    const keys = Object.keys(pkg.dependencies ?? {});
    expect(keys).toEqual(["zod"]);
  });

  it("src（テスト除く）の実行時 import は zod・相対パス・node: 組み込みだけである", () => {
    const files = listRuntimeSources(srcRoot);
    // 空の母集団で緑になる偽陰性を避ける。
    expect(files.length).toBeGreaterThan(20);
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of runtimeSpecifiers(readFileSync(file, "utf-8"))) {
        if (!isAllowedRuntimeSpecifier(spec)) {
          violations.push(`${relative(packageRoot, file)}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  describe("検査器自身の陽性対照", () => {
    it("違反の書き方を全部拾う", () => {
      const src = [
        `import { expect } from "vitest";`,
        `import ts from "typescript";`,
        `export * from "left-pad";`,
        `export { a } from "lodash";`,
        `const m = await import("chalk");`,
        `const r = require("fs");`,
        `import "side-effect";`,
        `void expect; void ts; void m; void r;`,
      ].join("\n");
      expect(
        runtimeSpecifiers(src)
          .filter((s) => !isAllowedRuntimeSpecifier(s))
          .sort(),
      ).toEqual(
        ["chalk", "fs", "left-pad", "lodash", "side-effect", "typescript", "vitest"].sort(),
      );
    });

    it("import type・型だけに使う import・許可された specifier は拾わない／許す", () => {
      const src = [
        `import type { Foo } from "vitest";`,
        `import { type Bar } from "typescript";`,
        `import { Baz } from "vitest";`,
        `export type { Q } from "lodash";`,
        `import { z } from "zod";`,
        `import { x } from "./x.js";`,
        `import { y } from "../y.js";`,
        `import { readFileSync } from "node:fs";`,
        `export const f = (a: Foo, b: Bar, c: Baz) => [z, x, y, readFileSync, a, b, c];`,
      ].join("\n");
      const specs = runtimeSpecifiers(src);
      expect(specs.filter((s) => !isAllowedRuntimeSpecifier(s))).toEqual([]);
      expect(specs).toEqual(expect.arrayContaining(["zod", "./x.js", "../y.js", "node:fs"]));
    });
  });
});
