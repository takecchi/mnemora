/**
 * ⛔ 入口の一覧を `exports` から導かない。導くと、`exports` から入口を消したときに一覧からも消えて、検査が黙って通る。
 * 一覧は独立に持ち、`exports` と両向きで突き合わせる。新しい入口を足したら `EXPECTED_ENTRY_POINTS` にも足すこと。
 */

import { readFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import ts from "typescript";
import {
  DECLARATION_EXTENSION_BY_SOURCE_EXTENSION,
  parseDeclarationFile,
} from "./public-api-surface-lib.mjs";

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

/**
 * ⛔ 出荷パッケージ全部を1つのプロジェクトへ入れない。`@mnemora/testkit` の peerDependencies の `zod` がトップへ置かれ、
 * core が `dependencies` から `zod` を落としても core の dist が解決できてしまう(#1890)。
 * 足すのは、そのパッケージが `dependencies` で頼る `@mnemora/*` の tarball だけ(`workspace:^` は未公開の版を指しうるので、
 * registry ではなく手元の tarball に解決させる)。peerDependencies は足さず、利用者の npm が自動で入れる姿に任せる。
 *
 * @param {readonly { name: string; tarball: string; dependencies?: Record<string, string> }[]} manifests
 * @param {readonly string[]} entries
 * @returns {{ name: string; installTarballs: string[]; entries: string[] }[]}
 */
export function planConsumerProjects(manifests, entries) {
  const tarballByName = new Map(manifests.map((m) => [m.name, m.tarball]));
  return manifests.map((m) => ({
    name: m.name,
    installTarballs: [
      m.tarball,
      ...Object.keys(m.dependencies ?? {})
        .filter((dep) => tarballByName.has(dep))
        .map((dep) => tarballByName.get(dep)),
    ],
    entries: entries.filter((spec) => spec === m.name || spec.startsWith(`${m.name}/`)),
  }));
}

export function buildSmokeTs(entries) {
  const lines = entries.map((spec, i) => `import * as e${i} from ${JSON.stringify(spec)};`);
  lines.push(`export const namespaces = [${entries.map((_, i) => `e${i}`).join(", ")}];`);
  return `${lines.join("\n")}\n`;
}

/**
 * 名前の一覧が無い・空のときは赤にする(抜き出しが壊れて何も見ていないのに緑、を作らない)。
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
 * @param {readonly string[]} entries
 * @param {Readonly<Record<string, readonly string[]>>} valueNames
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
 * ⚠ 型(TypeScript の `module: nodenext` から `require` したときの型解決)は見ない。
 *
 * @param {readonly string[]} entries
 * @param {Readonly<Record<string, readonly string[]>>} valueNames
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

/**
 * `skipLibCheck: true` は利用者の既定に合わせる。
 */
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
 * ⛔ snapshot の名前を平らに集めない。入口が再 export していない内部ファイルの宣言まで数えて、実行時に無いのが正しい名前で赤になる。
 * 入口から `export *` / `export { … } from` / `export { X }` を辿って、実際に見える名前だけを集める。
 *
 * 値と型は宣言の構文だけで決める。`const enum` は実行時に実体が無いので値に数えない(数えると偽陽性)。
 * `namespace`・`export =`・`export default`・`export import` は扱わず、出たら例外で止まる(黙って読み飛ばさない)。
 * 値の名前が undefined でないことだけを見る。
 */

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
 * @param {Map<string, ts.SourceFile>} sections
 * @param {string} path
 * @param {string[]} [stack]
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
 * 空なら例外にする(抜き出しが壊れたまま緑にしない)。
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
 * 入口の一覧は `EXPECTED_ENTRY_POINTS` が独立に持つ。ここで決めるのは入口ごとの起点だけ。
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
