import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".git", ".tmp"]);

function findFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      findFiles(join(dir, entry.name), predicate, out);
    } else if (predicate(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe("dangerouslyIgnoreUnhandledErrors を repo のどこにも設定していない（静的）", () => {
  it("vitest.config.mts のどれも dangerouslyIgnoreUnhandledErrors を設定していない", () => {
    const configFiles = findFiles(repoRoot, (name) => name === "vitest.config.mts");
    expect(configFiles.length).toBeGreaterThanOrEqual(6);

    const offenders = configFiles.filter((file) =>
      readFileSync(file, "utf8").includes("dangerouslyIgnoreUnhandledErrors"),
    );
    expect(offenders).toEqual([]);
  });

  it("package.json の scripts のどれも dangerouslyIgnoreUnhandledErrors を渡していない", () => {
    const manifests = findFiles(repoRoot, (name) => name === "package.json");
    expect(manifests.length).toBeGreaterThan(0);

    const offenders = [];
    for (const file of manifests) {
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
        if (String(command).includes("dangerouslyIgnoreUnhandledErrors")) {
          offenders.push(`${file}#scripts.${scriptName}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("vitest は『全部通ったが unhandled error が1件』を緑にしない（動的・実測）", () => {
  /** @type {string | undefined} */
  let fixtureDir;

  afterEach(() => {
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
      fixtureDir = undefined;
    }
  });

  it("テストが全部 passed でも、unhandled error が在れば exit code が非0になる", () => {
    // .tmp/ の下に作る（root の vitest の include に当たらない）。
    const tmpRoot = join(repoRoot, ".tmp");
    mkdirSync(tmpRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(tmpRoot, "no-unhandled-errors-"));

    writeFileSync(
      join(fixtureDir, "vitest.config.mts"),
      [
        'import { defineConfig } from "vitest/config";',
        "",
        "export default defineConfig({",
        '  test: { include: ["*.fixture.test.mjs"] },',
        "});",
        "",
      ].join("\n"),
    );

    // 本物の障害の形は再現しない。アサーションは全部通るのに非同期の未処理のエラーが1件在る形だけを DB 無しで作る。
    writeFileSync(
      join(fixtureDir, "unhandled.fixture.test.mjs"),
      [
        'import { it, expect } from "vitest";',
        'import { EventEmitter } from "node:events";',
        "",
        'it("passes but leaves an unhandled error behind", () => {',
        "  expect(1).toBe(1);",
        "  setImmediate(() => {",
        "    const ee = new EventEmitter();",
        '    ee.emit("error", new Error("synthetic unhandled error for gate check"));',
        "  });",
        "});",
        "",
      ].join("\n"),
    );

    const result = spawnSyncWithDeadline(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--root",
        fixtureDir,
        "--config",
        join(fixtureDir, "vitest.config.mts"),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        // NO_COLOR=1: FORCE_COLOR の下では reporter が出力にエスケープシーケンスを挟み、toContain が外れる。
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    // eslint-disable-next-line no-control-regex -- ANSI エスケープの除去に \x1b を使う。
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

    // 空白は `\s+` にする（桁揃えの変更に左右されない）。件数の数字は固定のまま（緩めると 1 passed と 2 passed を区別できない）。
    expect(plain).toMatch(/Test Files\s+1 passed\s+\(1\)/);
    expect(plain).toMatch(/Vitest caught\s+1\s+unhandled error/);
    expect(result.status).not.toBe(0);
  }, 60_000);
});
