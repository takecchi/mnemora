/**
 * `scripts/check-consumer-install.mjs`（出荷パッケージ（PUBLISH_TARGETS）を repo の外に入れて、利用者の立場で
 * 型と入口を確かめる道具。ADR 0346）の、ネットワークを使わない部品。
 *
 * ## 利用者が頼ってよい入口の一覧（{@link EXPECTED_ENTRY_POINTS}）
 *
 * 各パッケージの `exports` から一覧を**導かない**。導くと、`exports` から入口を消したときに
 * 一覧からも消えて、検査が黙って通る。⟹ 一覧はここに独立に持ち、`exports` と**両向きで**突き合わせる
 * （消えた入口も、一覧に無い新しい入口も、どちらも赤にする）。新しい入口を足したら、ここにも足すこと。
 */

import { readFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import ts from "typescript";
import {
  DECLARATION_EXTENSION_BY_SOURCE_EXTENSION,
  parseDeclarationFile,
} from "./public-api-surface-lib.mjs";

/** `import` で引ける入口（`./package.json` は除く）。 */
export const EXPECTED_ENTRY_POINTS = Object.freeze([
  "@mnemora/core",
  "@mnemora/testkit",
  "@mnemora/testkit/fixtures",
  "@mnemora/openai",
  "@mnemora/anthropic",
  "@mnemora/postgres",
  "@mnemora/local-embedding",
  "@mnemora/bullmq",
]);

/**
 * 1パッケージの package.json の `exports` から、`import` で引ける入口の指定子を列挙する
 * （`./package.json` は除く）。
 *
 * @param {{ name: string; exports?: Record<string, unknown> | string }} pkg
 * @returns {string[]}
 */
export function entryPointsFromExports(pkg) {
  if (pkg.exports === undefined || typeof pkg.exports === "string") {
    return [pkg.name];
  }
  return Object.keys(pkg.exports)
    .filter((key) => key !== "./package.json")
    .map((key) => (key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`));
}

/**
 * 期待する入口と、tarball の `exports` から列挙した入口を両向きで突き合わせる。
 *
 * @param {readonly string[]} expected
 * @param {readonly string[]} actual
 * @returns {{ missing: string[]; unexpected: string[] }}
 */
export function compareEntryPoints(expected, actual) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: expected.filter((x) => !a.has(x)),
    unexpected: actual.filter((x) => !e.has(x)),
  };
}

/** 型検査に掛ける入口ファイル（すべての入口を namespace で import し、使う）。 */
export function buildSmokeTs(entries) {
  const lines = entries.map((spec, i) => `import * as e${i} from ${JSON.stringify(spec)};`);
  lines.push(`export const namespaces = [${entries.map((_, i) => `e${i}`).join(", ")}];`);
  return `${lines.join("\n")}\n`;
}

/**
 * 実行時の検査の共通部分（ESM・CommonJS の両方の smoke に埋め込む）。`mod` の名前の検査だけを持つ。
 * 名前の一覧（`valueNames[spec]`）が無い・空のときは赤にする——抜き出しが壊れて何も見ていないのに緑、を作らない。
 */
const CHECK_VALUE_NAMES_SOURCE = `function checkValueNames(spec, mod, valueNames, failures) {
  const names = valueNames[spec];
  if (!Array.isArray(names) || names.length === 0) {
    failures.push(\`\${spec}: snapshot から引いた値の名前の一覧が空（抜き出しが壊れている）\`);
    return;
  }
  const missing = names.filter((name) => mod[name] === undefined);
  if (missing.length > 0) {
    failures.push(\`\${spec}: 実行時に undefined の値の名前がある（\${missing.length} 個）: \${missing.join(", ")}\`);
  }
}`;

/**
 * 実行に掛ける ESM の入口ファイル。各入口を import し、解決先が install 先の `node_modules` の
 * 配下であること（repo へ登っていないこと）と、名前が1つ以上 export されていること、
 * **snapshot の値の名前（{@link collectEntryValueNames}）が実行時に undefined でないこと**を確かめる。
 *
 * @param {readonly string[]} entries
 * @param {Readonly<Record<string, readonly string[]>>} valueNames 入口の指定子 → 値の名前の一覧
 */
export function buildSmokeMjs(entries, valueNames) {
  return `const entries = ${JSON.stringify(entries)};
const valueNames = ${JSON.stringify(valueNames)};
${CHECK_VALUE_NAMES_SOURCE}
const failures = [];
for (const spec of entries) {
  try {
    const resolved = import.meta.resolve(spec);
    if (!resolved.includes("/node_modules/")) {
      failures.push(\`\${spec}: install 先の node_modules の外へ解決した（\${resolved}）\`);
      continue;
    }
    const mod = await import(spec);
    if (Object.keys(mod).length === 0) failures.push(\`\${spec}: export が1つも無い\`);
    checkValueNames(spec, mod, valueNames, failures);
  } catch (error) {
    failures.push(\`\${spec}: \${error instanceof Error ? error.message : String(error)}\`);
  }
}
if (failures.length > 0) {
  console.error(failures.join("\\n"));
  process.exit(1);
}
console.log(\`ESM: \${entries.length} 個の入口をすべて import できた\`);
`;
}

/**
 * CommonJS から全入口を `require` する `smoke.cjs` の中身。README（core・postgres の「前提」）が約束する
 * 「CommonJS からは Node 22.12 以降の `require(esm)` で読み込める」を、install 先で確かめる。
 * `smoke.mjs` と同じく、解決先が `node_modules` の配下であることと、名前が1つ以上 export されていること、
 * snapshot の値の名前が実行時に undefined でないことを見る。
 * ⚠ 型（TypeScript の `module: nodenext` から `require` したときの型解決）は見ない。
 *
 * @param {readonly string[]} entries
 * @param {Readonly<Record<string, readonly string[]>>} valueNames 入口の指定子 → 値の名前の一覧
 */
export function buildSmokeCjs(entries, valueNames) {
  return `"use strict";
const entries = ${JSON.stringify(entries)};
const valueNames = ${JSON.stringify(valueNames)};
${CHECK_VALUE_NAMES_SOURCE}
const failures = [];
for (const spec of entries) {
  try {
    const resolved = require.resolve(spec);
    if (!resolved.includes("/node_modules/")) {
      failures.push(\`\${spec}: install 先の node_modules の外へ解決した（\${resolved}）\`);
      continue;
    }
    const mod = require(spec);
    if (Object.keys(mod).length === 0) failures.push(\`\${spec}: export が1つも無い\`);
    checkValueNames(spec, mod, valueNames, failures);
  } catch (error) {
    failures.push(\`\${spec}: \${error instanceof Error ? \`\${error.code ?? error.name}: \${error.message}\` : String(error)}\`);
  }
}
if (failures.length > 0) {
  console.error(failures.join("\\n"));
  process.exit(1);
}
console.log(\`CommonJS: \${entries.length} 個の入口をすべて require できた（require(esm)）\`);
`;
}

/** 型検査の tsconfig（`moduleResolution` ごと）。`skipLibCheck: true` は利用者の既定に合わせる。 */
export function buildTsconfig(moduleResolution) {
  const module = moduleResolution === "node16" ? "Node16" : "ESNext";
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module,
        moduleResolution,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      files: ["smoke.ts"],
    },
    null,
    2,
  )}\n`;
}

/**
 * ## snapshot（`scripts/__snapshots__/public-api/*.d.ts`）から、入口ごとの「値の名前」を引く
 *
 * snapshot は、入口から辿れる宣言ファイルを `// ===== <相対パス> =====` の見出しで連結したもの
 * （`buildPublicApiSnapshotText`）である。**全部の名前を平らに集めない**——入口が再 export していない
 * 内部のファイルの宣言（testkit の `__fixtures__/*` など）まで数えてしまい、実行時に無いのが正しい名前で赤になる。
 * ⟹ 入口のファイルから、`export *` / `export { a as b } from` / `export { X }`（自分の import を再 export）を
 * 辿って、その入口から**実際に見える名前**だけを集める。TypeScript の parser だけを使う（型検査器は使わない）。
 *
 * **値と型の区別**（宣言の構文だけで決める）:
 * - 値: `export declare const/let/var`・`function`・`class`・`enum`（`const enum` は除く）。
 * - 型: `interface`・`type`、`export type { … }`、`export { type X }`、`const enum`。
 *
 * **限界**:
 * - `const enum` は実行時に実体が無い（`preserveConstEnums` を切ったビルド）ので値に数えない。数えると赤の偽陽性になる。
 *   今の snapshot には無い。
 * - `namespace`・`export =`・`export default`・`export import` は扱わない。**出たら例外で止まる**（黙って読み飛ばさない）。
 * - 値の名前が実行時に `undefined` でないことだけを見る。値の中身（関数の引数・戻り値、クラスの形）は見ない。
 *   `export declare const X: undefined` のような、実行時に undefined が正しい値があれば偽陽性になる（今は無い）。
 * - snapshot は `pnpm run build` の出力の写しであり、tarball の `.d.ts` そのものではない。
 *   snapshot が古ければ、public-api の門（`check:public-api`）が先に赤になる。
 */

/** snapshot のテキストを、見出しの相対パス → SourceFile に割る。 */
export function splitSnapshotSections(snapshotText) {
  const sections = new Map();
  const re = /^\/\/ ===== (.+) =====$/gm;
  const heads = [...snapshotText.matchAll(re)];
  heads.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : snapshotText.length;
    sections.set(m[1], parseDeclarationFile(m[1], snapshotText.slice(start, end)));
  });
  return sections;
}

function hasModifier(node, kind) {
  return node.modifiers?.some((m) => m.kind === kind) ?? false;
}

function resolveSectionPath(fromPath, specifier) {
  const ext = extname(specifier);
  const declExt = DECLARATION_EXTENSION_BY_SOURCE_EXTENSION[ext];
  if (!declExt) {
    throw new Error(`未知の拡張子を持つ相対 import です: "${specifier}"（${fromPath} 内）`);
  }
  return posix.join(posix.dirname(fromPath), `${specifier.slice(0, -ext.length)}${declExt}`);
}

/**
 * 1つの宣言ファイル（見出しの相対パス）が外へ見せる名前を、{ 名前 → 値なら true } で返す。
 *
 * @param {Map<string, ts.SourceFile>} sections
 * @param {string} path
 * @param {string[]} [stack] 循環の検出
 * @returns {Map<string, boolean>}
 */
export function exportedNamesOfSection(sections, path, stack = []) {
  if (stack.includes(path))
    throw new Error(`再 export が循環している: ${[...stack, path].join(" -> ")}`);
  const sf = sections.get(path);
  if (!sf) throw new Error(`snapshot に見出し ${path} の節が無い`);
  const here = [...stack, path];
  const out = new Map();
  const sub = (specifier) =>
    exportedNamesOfSection(sections, resolveSectionPath(path, specifier), here);
  /** 自分のファイルの中の名前（export されていなくてもよい）が値か。 */
  const localIsValue = (name) => {
    for (const st of sf.statements) {
      if (
        ts.isImportDeclaration(st) &&
        st.importClause?.namedBindings &&
        ts.isNamedImports(st.importClause.namedBindings)
      ) {
        for (const el of st.importClause.namedBindings.elements) {
          if (el.name.text !== name) continue;
          if (st.importClause.isTypeOnly || el.isTypeOnly) return false;
          const target = sub(st.moduleSpecifier.text);
          const from = (el.propertyName ?? el.name).text;
          if (!target.has(from))
            throw new Error(`${path}: import した ${from} が ${st.moduleSpecifier.text} に無い`);
          return target.get(from);
        }
      }
      const declared = declaredNames(st);
      if (declared?.some((d) => d.name === name))
        return declared.find((d) => d.name === name).value;
    }
    throw new Error(`${path}: export { ${name} } の実体が見つからない`);
  };
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (!st.exportClause) {
        // export * from "./x.js"
        for (const [name, isValue] of sub(st.moduleSpecifier.text))
          if (!out.has(name)) out.set(name, isValue);
      } else if (ts.isNamedExports(st.exportClause)) {
        const target = st.moduleSpecifier ? sub(st.moduleSpecifier.text) : undefined;
        for (const el of st.exportClause.elements) {
          const from = (el.propertyName ?? el.name).text;
          let isValue;
          if (st.isTypeOnly || el.isTypeOnly) {
            isValue = false;
          } else if (target) {
            if (!target.has(from))
              throw new Error(`${path}: ${from} が ${st.moduleSpecifier.text} に無い`);
            isValue = target.get(from);
          } else {
            isValue = localIsValue(from);
          }
          out.set(el.name.text, isValue);
        }
      } else {
        throw new Error(`${path}: export * as ns は扱わない`);
      }
      continue;
    }
    if (
      ts.isExportAssignment(st) ||
      (ts.isImportEqualsDeclaration(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword))
    ) {
      throw new Error(`${path}: export = / export import は扱わない`);
    }
    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(st, ts.SyntaxKind.DefaultKeyword))
      throw new Error(`${path}: export default は扱わない`);
    const declared = declaredNames(st);
    if (!declared) throw new Error(`${path}: 扱えない export の形: ${ts.SyntaxKind[st.kind]}`);
    for (const d of declared) out.set(d.name, d.value);
  }
  return out;
}

/** 宣言文が導入する名前と、値か。宣言でない文・import は `undefined`。 */
function declaredNames(st) {
  if (ts.isVariableStatement(st)) {
    return st.declarationList.declarations.map((d) => {
      if (!ts.isIdentifier(d.name)) throw new Error("分割代入の export は扱わない");
      return { name: d.name.text, value: true };
    });
  }
  if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
    return st.name ? [{ name: st.name.text, value: true }] : undefined;
  }
  if (ts.isEnumDeclaration(st)) {
    return [{ name: st.name.text, value: !hasModifier(st, ts.SyntaxKind.ConstKeyword) }];
  }
  if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
    return [{ name: st.name.text, value: false }];
  }
  if (ts.isModuleDeclaration(st))
    throw new Error(`namespace / module の export は扱わない: ${st.name.text}`);
  return undefined;
}

/**
 * snapshot のテキストと入口のファイル（見出しの相対パス。例: `dist/index.d.ts`）から、
 * その入口の値の名前（重複なし・ソート済み）を返す。**空なら例外**（抜き出しが壊れたまま緑にしない）。
 *
 * @returns {string[]}
 */
export function collectEntryValueNames(snapshotText, entrySectionPath) {
  const sections = splitSnapshotSections(snapshotText);
  const names = [...exportedNamesOfSection(sections, entrySectionPath)]
    .filter(([, isValue]) => isValue)
    .map(([name]) => name)
    .sort();
  if (names.length === 0) {
    throw new Error(
      `${entrySectionPath}: snapshot から値の名前が1つも引けなかった（抜き出しが壊れている）`,
    );
  }
  return names;
}

/**
 * 入口の指定子（`@mnemora/testkit/fixtures`）ごとに、対応する snapshot と起点の `.d.ts` を決めて
 * 値の名前を引く。対応は作業ツリーの `packages/<名前>/package.json` の `exports.*.types` から取る
 * （入口の**一覧**は `EXPECTED_ENTRY_POINTS` が独立に持つ。ここで決めるのは入口ごとの起点だけ）。
 * snapshot のファイル名は `packages/<名前>` の `<名前>.d.ts`。
 *
 * @param {readonly string[]} entries
 * @param {string} repoRoot
 * @returns {Record<string, string[]>}
 */
export function collectValueNamesForEntries(entries, repoRoot) {
  /** @type {Record<string, string[]>} */
  const result = {};
  for (const spec of entries) {
    const m = /^@mnemora\/([^/]+)(?:\/(.+))?$/.exec(spec);
    if (!m) throw new Error(`想定外の入口の指定子: ${spec}`);
    const [, pkgDir, sub] = m;
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "packages", pkgDir, "package.json"), "utf8"),
    );
    const types = pkg.exports?.[sub ? `./${sub}` : "."]?.types;
    if (typeof types !== "string") throw new Error(`${spec}: exports に types が無い`);
    const snapshot = readFileSync(
      join(repoRoot, "scripts/__snapshots__/public-api", `${pkgDir}.d.ts`),
      "utf8",
    );
    result[spec] = collectEntryValueNames(snapshot, types.replace(/^\.\//, ""));
  }
  return result;
}
