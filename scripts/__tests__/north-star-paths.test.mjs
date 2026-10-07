import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extractGoalStatements } from "../north-star-default-probe-lib.mjs";

// 参照先が出荷パッケージの中かは確かめない（ADR 0216「(ア)」で退けた検査）。

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PATHS_DOC = "docs/north-star-paths.md";
const SNAPSHOT_DIR = "scripts/__snapshots__/public-api";

const ENTRY_LINE = /^- (口|実装|テスト): (.*)$/;
const API_REF = /^`([^`]+)` `([^`]+)`$/;
const FILE_REF = /^`([^`]+)`$/;
const TEST_REF = /^`([^`]+)` 「(.+)」$/;

/**
 * 形の崩れた行は `malformed` に出す（黙って読み飛ばすと、壊れた参照が緑になる）。
 *
 * @param {string} markdown
 */
function parsePathsDoc(markdown) {
  /** @type {Map<number, Array<{ kind: string, pkg?: string, name?: string, path?: string }>>} */
  const items = new Map();
  /** @type {string[]} */
  const malformed = [];
  let inPaths = false;
  let current = null;
  for (const line of markdown.split("\n")) {
    if (/^## /.test(line)) {
      inPaths = line.trim() === "## 経路";
      current = null;
      continue;
    }
    if (!inPaths) continue;
    const heading = line.match(/^### 項目(\d+)\s*$/);
    if (heading) {
      current = Number(heading[1]);
      items.set(current, []);
      continue;
    }
    const entry = line.match(ENTRY_LINE);
    if (!entry) continue;
    const [, kind, rest] = entry;
    const refs = current === null ? undefined : items.get(current);
    const parsed =
      kind === "口"
        ? rest.match(API_REF)?.slice(1)
        : kind === "実装"
          ? rest.match(FILE_REF)?.slice(1)
          : rest.match(TEST_REF)?.slice(1);
    if (refs === undefined || parsed === undefined) {
      malformed.push(line);
      continue;
    }
    if (kind === "口") refs.push({ kind, pkg: parsed[0], name: parsed[1] });
    else if (kind === "実装") refs.push({ kind, path: parsed[0] });
    else refs.push({ kind, path: parsed[0], name: parsed[1] });
  }
  return { items, malformed };
}

const IDENTIFIER_CHAR = "[A-Za-z0-9_$]";

const NON_RUNNING_MODIFIERS = new Set(["skip", "fails"]);

/**
 * @param {string} source
 * @param {string} name
 * @returns {{ found: false } | { found: true, modifiers: string[] }}
 */
function findTestDeclaration(source, name) {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  /** @type {{ found: false } | { found: true, modifiers: string[] }} */
  let result = { found: false };
  const visit = (node) => {
    if (result.found) return;
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const literal =
        first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
          ? first.text
          : undefined;
      if (literal === name) {
        /** @type {string[]} */
        const modifiers = [];
        let callee = node.expression;
        for (;;) {
          if (ts.isCallExpression(callee)) callee = callee.expression;
          else if (ts.isPropertyAccessExpression(callee)) {
            modifiers.unshift(callee.name.text);
            callee = callee.expression;
          } else break;
        }
        if (ts.isIdentifier(callee) && (callee.text === "it" || callee.text === "test")) {
          result = { found: true, modifiers };
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

/**
 * @param {ReturnType<typeof parsePathsDoc>["items"]} items
 * @param {string} root
 */
function findMissingReferences(items, root) {
  /** @type {string[]} */
  const missing = [];
  for (const [item, refs] of items) {
    for (const ref of refs) {
      if (ref.kind === "口") {
        const snapshot = join(root, SNAPSHOT_DIR, `${ref.pkg}.d.ts`);
        if (!existsSync(snapshot)) {
          missing.push(`項目${item} 口: スナップショット ${SNAPSHOT_DIR}/${ref.pkg}.d.ts が無い`);
          continue;
        }
        const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const word = new RegExp(`(?<!${IDENTIFIER_CHAR})${escaped}(?!${IDENTIFIER_CHAR})`);
        if (!word.test(readFileSync(snapshot, "utf8"))) {
          missing.push(`項目${item} 口: ${ref.pkg} の公開 API に ${ref.name} が無い`);
        }
        continue;
      }
      const file = join(root, ref.path);
      if (!existsSync(file)) {
        missing.push(`項目${item} ${ref.kind}: ${ref.path} が無い`);
        continue;
      }
      if (ref.kind === "テスト") {
        const declaration = findTestDeclaration(readFileSync(file, "utf8"), ref.name);
        if (!declaration.found) {
          missing.push(`項目${item} テスト: ${ref.path} に it「${ref.name}」が無い`);
        } else {
          const off = declaration.modifiers.filter((m) => NON_RUNNING_MODIFIERS.has(m));
          if (off.length > 0) {
            missing.push(
              `項目${item} テスト: ${ref.path} の it「${ref.name}」は .${off.join(".")} になっている`,
            );
          }
        }
      }
    }
  }
  return missing;
}

describe("docs/north-star-paths.md の参照先", () => {
  const doc = readFileSync(join(REPO_ROOT, PATHS_DOC), "utf8");
  const { items, malformed } = parsePathsDoc(doc);

  it("参照の行はすべて決まった形で書かれている", () => {
    expect(malformed).toEqual([]);
  });

  it("docs/north-star.md「目指す姿」の箇条それぞれに、### 項目N の節が在り、参照を1つ以上持つ", () => {
    const canon = extractGoalStatements(
      readFileSync(join(REPO_ROOT, "docs/north-star.md"), "utf8"),
    );
    expect(canon.ok).toBe(true);
    const count = canon.ok ? canon.statements.length : 0;
    const expected = Array.from({ length: count }, (_, i) => i + 1);
    expect([...items.keys()].sort((a, b) => a - b)).toEqual(expected);
    for (const n of expected) {
      expect(items.get(n)?.length ?? 0, `項目${n} に参照が無い`).toBeGreaterThan(0);
    }
  });

  it("口・実装・テストの参照先がすべて実在する", () => {
    expect(findMissingReferences(items, REPO_ROOT)).toEqual([]);
  });
});

describe("findTestDeclaration（陽性対照）", () => {
  const NAME = "北極星の歯が指す it";

  it("it(／test( の第1引数に在る名前は宣言として見つかり、修飾が無い", () => {
    expect(findTestDeclaration(`it("${NAME}", () => {});`, NAME)).toEqual({
      found: true,
      modifiers: [],
    });
    expect(findTestDeclaration(`test(\`${NAME}\`, () => {});`, NAME)).toEqual({
      found: true,
      modifiers: [],
    });
  });

  it("名前がコメントや it でない呼び出しの引数にあるだけなら、宣言としては見つからない", () => {
    expect(findTestDeclaration(`// it("${NAME}")\nit("別の名前", () => {});`, NAME)).toEqual({
      found: false,
    });
    expect(findTestDeclaration(`describe("${NAME}", () => {});`, NAME)).toEqual({ found: false });
    expect(findTestDeclaration(`const s = "${NAME}";`, NAME)).toEqual({ found: false });
  });

  it(".skip／.fails／.skipIf(…) の修飾を拾う", () => {
    expect(findTestDeclaration(`it.skip("${NAME}", () => {});`, NAME)).toEqual({
      found: true,
      modifiers: ["skip"],
    });
    expect(findTestDeclaration(`it.fails("${NAME}", () => {});`, NAME)).toEqual({
      found: true,
      modifiers: ["fails"],
    });
    expect(findTestDeclaration(`it.skipIf(x)("${NAME}", () => {});`, NAME)).toEqual({
      found: true,
      modifiers: ["skipIf"],
    });
  });
});

describe("parsePathsDoc / findMissingReferences（陽性対照）", () => {
  const broken = [
    "## 経路",
    "",
    "### 項目1",
    "",
    "- 口: `core` `createRuntime`",
    "- 口: `core` `noSuchExportForNorthStarPaths`",
    "- 実装: `packages/core/src/no-such-file.ts`",
    "- テスト: `packages/core/src/__tests__/recall-association.test.ts` 「この名前の it は無い」",
    "- テスト: packages/core/src/__tests__/recall.test.ts",
    "",
  ].join("\n");

  it("形の崩れた行を malformed に出す", () => {
    expect(parsePathsDoc(broken).malformed).toEqual([
      "- テスト: packages/core/src/__tests__/recall.test.ts",
    ]);
  });

  it("無い名前・無いファイル・無い it を、在るものと分けて報告する", () => {
    expect(findMissingReferences(parsePathsDoc(broken).items, REPO_ROOT)).toEqual([
      "項目1 口: core の公開 API に noSuchExportForNorthStarPaths が無い",
      "項目1 実装: packages/core/src/no-such-file.ts が無い",
      "項目1 テスト: packages/core/src/__tests__/recall-association.test.ts に it「この名前の it は無い」が無い",
    ]);
  });
});
