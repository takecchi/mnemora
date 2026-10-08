import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 3者照合の `EXPECTED` は、core の `fake-<名前>-parity.test.ts`（Fake を縛る）と
 * postgres の `<名前>-parity.postgres.test.ts`（InMemory と Postgres を縛る）にコピーで置かれている。
 * 片方だけを直すと、3者が別々の期待値に縛られたまま両方とも緑になる。その2つのコピーが同じであることを縛る。
 * 組は名前から引く（件数をここに写さない）。
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreDir = "packages/core/src/__tests__";
const postgresDir = "packages/postgres/src/__tests__";

/** トップレベルの `const EXPECTED` の初期化子の原文。無ければ undefined。 */
function expectedInitializerText(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === "EXPECTED" && decl.initializer) {
        return decl.initializer.getText(sf);
      }
    }
  }
  return undefined;
}

/** `EXPECTED` を持つ照合ファイルを、名前（`<名前>-parity`）から引く。 */
function filesWithExpected(dir, pattern) {
  const out = new Map();
  for (const f of readdirSync(join(repoRoot, dir))) {
    const m = f.match(pattern);
    if (!m) continue;
    const text = expectedInitializerText(readFileSync(join(repoRoot, dir, f), "utf8"), f);
    if (text !== undefined) out.set(m[1], { path: `${dir}/${f}`, text });
  }
  return out;
}

const core = filesWithExpected(coreDir, /^fake-(.+)-parity\.test\.ts$/);
const postgres = filesWithExpected(postgresDir, /^(.+)-parity\.postgres\.test\.ts$/);

describe("3者照合の EXPECTED のコピーが、core と postgres で同じである", () => {
  it("組が1つ以上見つかり、どちらの側にも相方の無い EXPECTED が無い", () => {
    expect(core.size).toBeGreaterThan(0);
    expect([...core.keys()].sort()).toEqual([...postgres.keys()].sort());
  });

  it.each([...core.keys()].sort())("%s: 2つの EXPECTED の原文が一致する", (name) => {
    const a = core.get(name);
    const b = postgres.get(name);
    expect(
      b,
      `${a.path} の相方 ${postgresDir}/${name}-parity.postgres.test.ts に EXPECTED が無い`,
    ).toBeDefined();
    expect(b.text, `${a.path} と ${b.path} の EXPECTED がずれている`).toBe(a.text);
  });
});

describe("expectedInitializerText（取り出し方そのもの）", () => {
  it("トップレベルの EXPECTED だけを取り、関数の中の同名や別名の定数は取らない", () => {
    const src = [
      "const EXPECTED_X = { a: 1 };",
      "function f() { const EXPECTED = { b: 2 }; return EXPECTED; }",
      "const EXPECTED: Result = { c: 3 };",
    ].join("\n");
    expect(expectedInitializerText(src, "x.ts")).toBe("{ c: 3 }");
    expect(expectedInitializerText("const OTHER = 1;", "x.ts")).toBeUndefined();
  });

  it("値が1文字違えば別の原文になる", () => {
    expect(expectedInitializerText('const EXPECTED = { id: "a" };', "x.ts")).not.toBe(
      expectedInitializerText('const EXPECTED = { id: "A" };', "x.ts"),
    );
  });
});
