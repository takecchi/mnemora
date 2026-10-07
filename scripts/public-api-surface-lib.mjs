/**
 * ⚠ 既存 devDependency の `typescript` だけを使う。新規依存はオーナー専権(`docs/autonomy.md` §3)。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * ⚠ 素朴に「`.js` を `.d.ts` に変える」変換だけでは、`.cjs` を指す import(例: `migrate.d.ts` の `./migrations-dir.cjs`)を取りこぼす。
 * BFS が辿れず、snapshot に穴が空く。
 */
export const DECLARATION_EXTENSION_BY_SOURCE_EXTENSION = {
  ".js": ".d.ts",
  ".mjs": ".d.mts",
  ".cjs": ".d.cts",
};

function toPosixPath(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * ⚠ `exports` だけを見る。複数エントリ(`"."` と `"./fixtures"` 等)は両方拾う。1エントリだけだと、もう一方からしか届かない宣言を見落とす。
 */
export function entryTypesFilesFromExports(packageJson, packageDir) {
  const exportsField = packageJson.exports;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    throw new Error(`package.json に exports（オブジェクト）が無い: ${packageDir}`);
  }
  const entries = [];
  for (const [subpath, value] of Object.entries(exportsField)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const typesPath = value.types;
    if (typeof typesPath !== "string") {
      continue;
    }
    entries.push({ subpath, absPath: resolve(packageDir, typesPath) });
  }
  if (entries.length === 0) {
    throw new Error(`package.json の exports に types を持つエントリが1つも無い: ${packageDir}`);
  }
  return entries;
}

/**
 * 相対でない指定子は `null`(外部パッケージの型は公開面ではない)。
 * 対応表に無い拡張子・実在しない解決先は例外を投げる。黙って読み飛ばさない(対応表が古くなったまま気づかれない事故を避ける)。
 */
export function resolveRelativeDeclarationImport(specifier, fromDir) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const ext = extname(specifier);
  if (ext === ".json") {
    return null;
  }
  const declExt = DECLARATION_EXTENSION_BY_SOURCE_EXTENSION[ext];
  if (!declExt) {
    throw new Error(
      `未知の拡張子を持つ相対 import です（対応表 DECLARATION_EXTENSION_BY_SOURCE_EXTENSION に ` +
        `追加すること）: "${specifier}"（${fromDir} 内）`,
    );
  }
  const withoutExt = specifier.slice(0, specifier.length - ext.length);
  const candidate = resolve(fromDir, `${withoutExt}${declExt}`);
  if (!existsSync(candidate)) {
    throw new Error(
      `相対 import が指す宣言ファイルが実在しません: "${specifier}" -> ${candidate}（${fromDir} 内）。` +
        `dist が古いか、ビルドが壊れています。`,
    );
  }
  return candidate;
}

export function parseDeclarationFile(absPath, text = readFileSync(absPath, "utf8")) {
  return ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * `import("./x.js").Foo` のような型位置の動的 import 型も拾う。トップレベルの import/export 文だけを見ると、型注釈の奥に埋め込まれたこの形を見落とすので `ts.forEachChild` で再帰する。
 */
export function collectRelativeImportSpecifiers(sourceFile) {
  const specifiers = new Set();
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.add(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...specifiers];
}

/**
 * ⛔ `dist/` を無差別に列挙しない。この BFS だけが到達可能性の根拠(どの `.d.ts` からも import されない内部専用ファイルを入れない)。
 */
export function collectReachableDeclarationFiles(entryAbsPaths) {
  const visited = new Set();
  const queue = [...entryAbsPaths];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) {
      continue;
    }
    if (!existsSync(current)) {
      throw new Error(`宣言ファイルが実在しません: ${current}`);
    }
    visited.add(current);
    const sourceFile = parseDeclarationFile(current);
    const fromDir = dirname(current);
    for (const specifier of collectRelativeImportSpecifiers(sourceFile)) {
      const resolved = resolveRelativeDeclarationImport(specifier, fromDir);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return [...visited].sort();
}

/**
 * JSDoc を残したまま diff を取ると、公開面が変わった行との signal/noise 比が落ちるのでコメントを剥がす。
 * printer が改行・インデントを出し直すのは狙った副作用で、ソースの揺れに緑/赤が左右されなくなる。
 */
export function normalizeDeclarationText(absPath) {
  const sourceFile = parseDeclarationFile(absPath);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(sourceFile);
}

/**
 * 並びは相対パスの辞書順に固定する(実行環境や BFS の探索順に左右されない)。
 */
export function buildPublicApiSnapshotText(packageDir, packageJson) {
  const entries = entryTypesFilesFromExports(packageJson, packageDir);
  const entryAbsPaths = [...entries.map((e) => e.absPath)].sort();
  for (const absPath of entryAbsPaths) {
    if (!existsSync(absPath)) {
      throw new Error(
        `exports.*.types が指すファイルが実在しません: ${absPath}。` +
          `先に \`pnpm run build\` を実行してください。`,
      );
    }
  }
  const reachable = collectReachableDeclarationFiles(entryAbsPaths);
  const sections = reachable.map((absPath) => {
    const relPath = toPosixPath(relative(packageDir, absPath));
    const normalized = normalizeDeclarationText(absPath).trimEnd();
    return `// ===== ${relPath} =====\n${normalized}\n`;
  });
  return `${sections.join("\n")}`;
}
