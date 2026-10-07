import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const conformanceDoc = readFileSync(join(repoRoot, "docs/conformance.md"), "utf8");
const suiteDir = join(repoRoot, "packages/testkit/src");
const suiteFiles = readdirSync(suiteDir).filter((f) => f.endsWith("-conformance.ts"));

function formulaFromDoc() {
  const section = conformanceDoc.slice(conformanceDoc.indexOf("## 1. "));
  const m = section.match(/grep -cE '([^']+)' packages\/testkit\/src\/\*-conformance\.ts/);
  if (!m) throw new Error("docs/conformance.md §1 に数え方の式が見つからない");
  return new RegExp(m[1]);
}

function aliasesOf(sf) {
  const names = new Set();
  const mentionsIt = (node) => {
    let found = false;
    const visit = (n) => {
      if (ts.isIdentifier(n) && n.text === "it") found = true;
      if (!found) ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !ts.isArrowFunction(node.initializer) &&
      !ts.isFunctionExpression(node.initializer) &&
      mentionsIt(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function calleeRoot(expr) {
  let e = expr;
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else break;
  }
  return ts.isIdentifier(e) ? e.text : undefined;
}

function countItStatements(sf, itNames) {
  let count = 0;
  const visit = (node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const root = calleeRoot(node.expression.expression);
      if (root !== undefined && itNames.has(root)) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

describe("docs/conformance.md §1 の数え方の式は、適合テストの it の宣言を取りこぼさない", () => {
  const formula = formulaFromDoc();
  const parsed = suiteFiles.map((file) => {
    const text = readFileSync(join(suiteDir, file), "utf8");
    return { file, text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
  });

  it("陽性対照: 適合テストのファイルを見つけ、別名を実際に拾えている", () => {
    expect(suiteFiles.length).toBeGreaterThanOrEqual(8);
    const all = new Set(parsed.flatMap(({ sf }) => [...aliasesOf(sf)]));
    expect(all.has("maybeIt")).toBe(true);
  });

  it("it を値に持つ別名は、どれも式の `maybe[A-Za-z]*It` に当たる名前である", () => {
    const offending = parsed.flatMap(({ file, sf }) =>
      [...aliasesOf(sf)]
        .filter((name) => !/^maybe[A-Za-z]*It$/.test(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(offending).toEqual([]);
  });

  it("ファイルごとに、式が数える行の数と、構文解析で数えた it の呼び出しの数が一致する", () => {
    const mismatches = parsed
      .map(({ file, text, sf }) => {
        const byFormula = text.split("\n").filter((line) => formula.test(line)).length;
        const byAst = countItStatements(sf, new Set(["it", ...aliasesOf(sf)]));
        return { file, byFormula, byAst };
      })
      .filter((r) => r.byFormula !== r.byAst);
    expect(mismatches).toEqual([]);
  });
});
