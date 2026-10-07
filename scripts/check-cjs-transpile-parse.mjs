#!/usr/bin/env node
/**
 * `import.meta` は CommonJS として解析されると early error になる。関数の中でも、呼ばなくても、
 * 読み込んだ時点で落ちるので、遅延評価にしても直らない。TypeScript の `transpileModule` はこれを
 * 素通しするため、`tsc` の型検査や `node` での実行では気づけない。
 *
 * ⛔ `grep "import.meta"` にしない。`vm.compileFunction` は構文解析だけを行い(実行しない)、
 * コメントの中の文字列で誤検知も見逃しもしない。`migrations-dir.cjs` の doc コメントは
 * その文字列を含むので、`grep` ベースの門は誤って赤くなる。
 *
 * 見るのは `src/` ではなくビルド後の `dist/`。テストランナーが `require()` するのは配布物であるため。
 *
 * 対象パッケージのリストをここに複製しない(ADR 0066)。`PUBLISH_TARGETS` に一箇所へ集める。
 *
 * 🔴 `dist` が無い・対象が0件のときは、黙って緑にせず非0で落とす。ビルド忘れは「確認していない」のに
 * 緑になる。この門には、他のジョブが別の場所で本物を担保してくれる構成が無い。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const BANNER = "─".repeat(72);

/**
 * root から解決できない環境向けに、`packages/postgres/node_modules` 経由の借用を後退路として持つ。
 */
async function loadTypeScript() {
  try {
    return (await import("typescript")).default;
  } catch {
    const require = createRequire(join(repoRoot, "packages", "postgres", "package.json"));
    return require("typescript");
  }
}

const packagesRoot = process.env.CJS_PARSE_CHECK_PACKAGES_ROOT
  ? resolve(process.env.CJS_PARSE_CHECK_PACKAGES_ROOT)
  : join(repoRoot, "packages");
const displayRoot = process.env.CJS_PARSE_CHECK_PACKAGES_ROOT
  ? resolve(packagesRoot, "..")
  : repoRoot;

function listDistFiles(distDir) {
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir, { recursive: true })
    .map((rel) => join(distDir, rel))
    .filter((abs) => statSync(abs).isFile())
    .filter((abs) => /\.(?:js|cjs|mjs)$/.test(abs));
}

console.log(
  [
    "",
    BANNER,
    `CJS 構文解析の門: 対象${PUBLISH_TARGETS.length}パッケージのビルド後配布物（packages/*/dist）を`,
    "ts-jest 相当の変換に通してから CommonJS として構文解析します（Issue #110）",
    "",
    "  対象:",
    ...PUBLISH_TARGETS.map((t) => `    - ${t.name} (${basename(t.dir)}/dist)`),
    BANNER,
    "",
  ].join("\n"),
);

const missingDist = [];
/** @type {{ target: string; file: string }[]} */
const targetFiles = [];

for (const target of PUBLISH_TARGETS) {
  const distDir = join(packagesRoot, basename(target.dir), "dist");
  if (!existsSync(distDir)) {
    missingDist.push(target.name);
    continue;
  }
  for (const file of listDistFiles(distDir)) {
    targetFiles.push({ target: target.name, file });
  }
}

if (missingDist.length > 0) {
  console.log(
    [
      "",
      BANNER,
      `✖ dist が見つかりません: ${missingDist.join(", ")}`,
      "",
      "  この門はビルド後の配布物を検査するものであり、dist が無いパッケージがあると",
      "  「検査していないのに緑」になってしまいます。先に `pnpm run build` を打ってください。",
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (targetFiles.length === 0) {
  console.log(
    [
      "",
      BANNER,
      "✖ 検査対象のファイルが1件も見つかりませんでした（.js / .cjs / .mjs が0件）",
      "",
      "  対象0件のまま緑にする門は、空振りしていても気づけません。",
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const ts = await loadTypeScript();

/** @type {{ target: string; file: string; error: Error }[]} */
const violations = [];

for (const { target, file } of targetFiles) {
  const source = readFileSync(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;

  try {
    vm.compileFunction(transpiled, ["exports", "require", "module", "__filename", "__dirname"], {
      filename: file,
    });
  } catch (error) {
    violations.push({ target, file, error });
  }
}

if (violations.length > 0) {
  const lines = violations.flatMap(({ target, file, error }) => {
    const displayPath = relative(displayRoot, file);
    return [
      `✖ ${displayPath} は CommonJS として解析できません`,
      `    ${error.constructor.name}: ${error.message}`,
      `  ⟹ CJS へ変換するテストランナー（ts-jest 等）から ${target} を読み込めなくなります（Issue #110）。`,
      "     import.meta は CJS では構文解析の時点で落ちるため、関数の中へ移しても直りません。",
      "     自分の位置を知る必要が在るなら、packages/postgres/src/migrations-dir.cts のように",
      "     CommonJS のファイルへ追い出してください。",
      "",
    ];
  });

  console.log(
    ["", BANNER, `✖ 違反が ${violations.length} 件見つかりました`, "", ...lines, BANNER, ""].join(
      "\n",
    ),
  );
  process.exit(1);
}

console.log(
  [
    "",
    BANNER,
    `✔ ${targetFiles.length} 個の配布物が CommonJS として解析できました。`,
    BANNER,
    "",
  ].join("\n"),
);
