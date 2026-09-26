import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkSnippets,
  extractCheckedSnippets,
  hostDirFor,
  loadCompilerOptions,
} from "../check-doc-snippets-lib.mjs";

/**
 * ⭐ **この歯が測っているもの**（ADR 0345）
 *
 * `scripts/check-doc-snippets.mjs`（文書の印付きコード片の型検査の門）の、抜き出しと型検査の部品。
 *
 * ⚠ **公開パッケージの `dist` を1つも読まない。**CI ではこのテストが Build より先に走るため、
 * 型検査の側は `@mnemora/*` を import しない合成の片と、合成の前提の宣言で確かめる。
 * `dist` に当てる本番の実行は、CI の build ジョブの Build の後の段
 * （`pnpm run check:doc-snippets`）が担う（`ci-yml-doc-snippets-wiring.test.mjs` が配線を固定する）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const compilerOptions = loadCompilerOptions(repoRoot);
const globalsSource = "declare const answer: number;\n";

const check = (code, file = "docs/example.md", line = 10) =>
  checkSnippets({ repoRoot, snippets: [{ file, line, code }], globalsSource, compilerOptions })[0];

describe("extractCheckedSnippets: 印を付けた片だけを抜き出す", () => {
  it("```ts check と ```typescript check を拾い、印の無い片・他の info string は拾わない", () => {
    const md = [
      "# t", // 1
      "```ts check", // 2
      "const a = 1;", // 3
      "```", // 4
      "```ts", // 5
      "const b = 1;", // 6
      "```", // 7
      "```typescript check", // 8
      "const c = 1;", // 9
      "```", // 10
      "```tsx check", // 11
      "const d = 1;", // 12
      "```", // 13
      "```ts checked", // 14
      "const e = 1;", // 15
      "```", // 16
      "```bash check", // 17
      "echo f", // 18
      "```", // 19
    ].join("\n");
    expect(extractCheckedSnippets(md)).toEqual([
      { line: 3, code: "const a = 1;" },
      { line: 9, code: "const c = 1;" },
    ]);
  });

  it("印の無いフェンスの中に在る ```ts check の行は、片の始まりとして扱わない", () => {
    const md = ["````md", "```ts check", "const a = 1;", "```", "````"].join("\n");
    expect(extractCheckedSnippets(md)).toEqual([]);
  });

  it("字下げされたフェンス（リストの中）は、字下げを外して抜き出す", () => {
    const md = ["- 項目", "  ```ts check", "  const a = 1;", "    const b = 2;", "  ```"].join(
      "\n",
    );
    expect(extractCheckedSnippets(md)).toEqual([{ line: 3, code: "const a = 1;\n  const b = 2;" }]);
  });

  it("~~~ のフェンスも拾い、閉じは同じ文字・同じ長さ以上でだけ閉じる", () => {
    const md = ["~~~ts check", "const a = 1;", "```", "~~~"].join("\n");
    expect(extractCheckedSnippets(md)).toEqual([{ line: 2, code: "const a = 1;\n```" }]);
  });
});

describe("checkSnippets: まとめて型検査し、Markdown の行番号で返す", () => {
  it("通る片は診断が0件", () => {
    expect(check("const n: number = 1;\n").diagnostics).toEqual([]);
  });

  it("🔴 陽性対照: 型の合わない片は落ち、行番号は Markdown の中の行に読み替える", () => {
    const r = check('const a = 1;\nconst n: number = "x";\n', "docs/example.md", 10);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ line: 11, code: 2322 });
  });

  it("構文の壊れた片（わざと空けた箇所）も落ちる", () => {
    expect(check("const id = /* 呼び出し側が選ぶ */;\n").diagnostics.length).toBeGreaterThan(0);
  });

  it("前提の変数は大域の宣言から補われ、その型で検査される（any で補っていない）", () => {
    expect(check("const x: number = answer + 1;\n").diagnostics).toEqual([]);
    expect(check("const s: string = answer;\n").diagnostics[0]).toMatchObject({ code: 2322 });
  });

  it("片が同じ名前を自分で宣言すれば、片の側が勝つ（衝突しない）", () => {
    expect(check('const answer = "own";\nconst s: string = answer;\n').diagnostics).toEqual([]);
  });

  it("strict で検査する（暗黙の any は落ちる）", () => {
    expect(check("const f = (x) => x;\n").diagnostics[0]).toMatchObject({ code: 7006 });
  });

  it("top-level await を書ける（片は ESM として検査する）", () => {
    expect(check("await Promise.resolve(1);\n").diagnostics).toEqual([]);
  });

  it("片ごとに別のモジュールとして検査する（別の片の宣言は見えない）", () => {
    const [a, b] = checkSnippets({
      repoRoot,
      globalsSource,
      compilerOptions,
      snippets: [
        { file: "docs/a.md", line: 1, code: "const onlyInA = 1;\n" },
        { file: "docs/b.md", line: 1, code: "const y = onlyInA;\n" },
      ],
    });
    expect(a.diagnostics).toEqual([]);
    expect(b.diagnostics[0]).toMatchObject({ code: 2304 });
  });
});

describe("hostDirFor: どこから解決するか", () => {
  it("packages/<name>/ と examples/<name>/ の下はその package、それ以外は examples/chat", () => {
    expect(hostDirFor("packages/local-embedding/README.md")).toBe("packages/local-embedding");
    expect(hostDirFor("examples/chat/README.md")).toBe("examples/chat");
    expect(hostDirFor("README.md")).toBe("examples/chat");
    expect(hostDirFor("docs/migration-v1.md")).toBe("examples/chat");
  });
});
