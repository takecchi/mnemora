import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/** 実物の dist は読まない。CI では Test 段が Build 段より前にあり、dist がまだ無いことがある。フィクスチャは一時ディレクトリに作る。 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../check-cjs-transpile-parse.mjs", import.meta.url));

// `PUBLISH_TARGETS` と同じ7パッケージ名。フィクスチャの形を手で組むので、名前を直書きする。
const PACKAGE_DIRS = [
  "core",
  "testkit",
  "openai",
  "postgres",
  "anthropic",
  "local-embedding",
  "bullmq",
];

/** @type {string | undefined} */
let fixtureRoot;

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
});

function newFixtureRoot() {
  const base = mkdtempSync(join(tmpdir(), "cjs-parse-check-"));
  const packagesDir = join(base, "packages");
  mkdirSync(packagesDir, { recursive: true });
  return packagesDir;
}

function writeCleanDistForAll(packagesDir) {
  for (const name of PACKAGE_DIRS) {
    const distDir = join(packagesDir, name, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.js"), "export const ok = true;\n");
  }
}

function writeDistFile(packagesDir, name, contents) {
  const distDir = join(packagesDir, name, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.js"), contents);
}

function runGate(packagesDir) {
  const result = spawnSyncWithDeadline(process.execPath, [gate], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CJS_PARSE_CHECK_PACKAGES_ROOT: packagesDir },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("scripts/check-cjs-transpile-parse.mjs（CJS 構文解析の門）", () => {
  it("import.meta を実際に使う配布物を与えると赤くなる（Issue #110 に言及する）", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);
    writeDistFile(
      fixtureRoot,
      "anthropic",
      ["export const selfUrl = new URL(import.meta.url);", ""].join("\n"),
    );

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
    expect(output).toContain("CommonJS として解析できません");
    expect(output).toContain("Cannot use 'import.meta' outside a module");
    expect(output).toContain("Issue #110");
  });

  it("きれいな配布物だけを与えると緑になる", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した EXIT=0 にならなかった。出力:\n${output}`).toBe(0);
    expect(output).toContain("個の配布物が CommonJS として解析できました");
    expect(output).toContain(`✔ ${PACKAGE_DIRS.length} 個の配布物`);
  });

  /** 文字列の有無ではなく構文解析で測っていること。実物の `migrations-dir.cjs` は doc コメントに `import.meta` を含む。 */
  it("import.meta という文字列がコメントの中だけに在る配布物では緑のままである", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);
    writeDistFile(
      fixtureRoot,
      "postgres",
      [
        "/**",
        " * なぜ import.meta を避けたか。",
        " * import.meta は CommonJS として解析されると構文解析の時点で落ちる。",
        " * import.meta.url は使わない。import.meta.resolve も使わない。",
        " */",
        "export const DEFAULT_MIGRATIONS_DIR = __dirname;",
        "",
      ].join("\n"),
    );

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した EXIT=0 にならなかった。出力:\n${output}`).toBe(0);
    expect(output).toContain("個の配布物が CommonJS として解析できました");
    expect(output).not.toContain("CommonJS として解析できません");
  });

  it("dist が無いパッケージが在ると赤くなる（先に build を打てと言う）", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);
    rmSync(join(fixtureRoot, "anthropic"), { recursive: true, force: true });

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
    expect(output).toContain("dist が見つかりません");
    expect(output).toContain("@mnemora/anthropic");
    expect(output).toContain("pnpm run build");
  });

  it("対象ファイルが0件だと赤くなる（空振りで緑にしない）", () => {
    fixtureRoot = newFixtureRoot();
    for (const name of PACKAGE_DIRS) {
      const distDir = join(fixtureRoot, name, "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "index.d.ts"), "export {};\n");
    }

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
    expect(output).toContain("検査対象のファイルが1件も見つかりませんでした");
  });

  it.each(["index.cjs", "index.mjs"])(
    "拡張子が %s の配布物も検査し、import.meta を使っていれば赤くなる",
    (fileName) => {
      fixtureRoot = newFixtureRoot();
      writeCleanDistForAll(fixtureRoot);
      writeFileSync(
        join(fixtureRoot, "core", "dist", fileName),
        "export const selfUrl = new URL(import.meta.url);\n",
      );

      const { status, output } = runGate(fixtureRoot);

      expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
      expect(output).toContain(`${fileName} は CommonJS として解析できません`);
    },
  );

  it("dist の下のサブディレクトリに在る配布物も検査し、import.meta を使っていれば赤くなる", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);
    const nestedDir = join(fixtureRoot, "postgres", "dist", "bin");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "migrate.js"), "export const here = import.meta.url;\n");

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
    expect(output).toContain(join("bin", "migrate.js"));
    expect(output).toContain("CommonJS として解析できません");
  });
});
