import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

// 静的な歯（文字列の grep）では測らず、本物の run-db-tests.mjs を子プロセスで起動して区間の重なりを測る。
// 本物をそのまま import せず擬似ワークスペースへコピーする: スクリプトは自分の import.meta.url から
// repo の場所を決める。symlink は Node が実体パスへ解決するので使えない。

const REAL_SCRIPT_PATH = fileURLToPath(new URL("../run-db-tests.mjs", import.meta.url));

// コピーする名前を手で並べない（依存が増えると漏れて、排他と無関係な ERR_MODULE_NOT_FOUND で赤くなる）。
function copyScriptWithLocalDeps(sourcePath, destDir, copied = new Set()) {
  const name = basename(sourcePath);
  if (copied.has(name)) return;
  copied.add(name);
  copyFileSync(sourcePath, join(destDir, name));
  const source = readFileSync(sourcePath, "utf8");
  for (const matched of source.matchAll(/from\s+"\.\/([^"]+\.mjs)"/g)) {
    copyScriptWithLocalDeps(join(dirname(sourcePath), matched[1]), destDir, copied);
  }
}

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(sleepMs) {
  const dir = mkdtempSync(join(tmpdir(), "run-db-tests-exclusivity-"));
  tmpDirs.push(dir);

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "exclusivity-probe-root", private: true }),
  );
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "pkg-a"\n  - "pkg-b"\n');

  for (const pkg of ["pkg-a", "pkg-b"]) {
    mkdirSync(join(dir, pkg), { recursive: true });
    // 互いに依存させない（依存させると位相ソートが直列にする理由を作り、排他が測れなくなる）。
    writeFileSync(
      join(dir, pkg, "package.json"),
      JSON.stringify({
        name: pkg,
        version: "0.0.0",
        private: true,
        scripts: { "test:db": "node ./run.mjs" },
      }),
    );
    writeFileSync(
      join(dir, pkg, "run.mjs"),
      [
        'import fs from "node:fs";',
        "const log = process.env.TIMELINE_LOG;",
        `const name = ${JSON.stringify(pkg)};`,
        "fs.appendFileSync(log, `${name} start ${Date.now()}\\n`);",
        `await new Promise((r) => setTimeout(r, ${sleepMs}));`,
        "fs.appendFileSync(log, `${name} end ${Date.now()}\\n`);",
      ].join("\n"),
    );
  }

  mkdirSync(join(dir, "scripts"), { recursive: true });
  // symlink ではなくコピー。1ファイルだけをコピーしない（import を辿って運ぶ）。
  copyScriptWithLocalDeps(REAL_SCRIPT_PATH, join(dir, "scripts"));

  return dir;
}

/** @returns {{ name: string; start: number; end: number }[]} */
function parseTimeline(logPath) {
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  /** @type {Record<string, { start?: number; end?: number }>} */
  const byName = {};
  for (const line of lines) {
    const [name, kind, ts] = line.split(" ");
    byName[name] ??= {};
    byName[name][kind] = Number(ts);
  }
  return Object.entries(byName).map(([name, { start, end }]) => ({ name, start, end }));
}

function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

describe("scripts/run-db-tests.mjs の排他（振る舞いの歯）", () => {
  it("互いに依存しない2パッケージの test:db を、区間が重ならないよう順に実行する", () => {
    const dir = makeWorkspace(400);
    const timelineLog = join(dir, "timeline.log");
    writeFileSync(timelineLog, "");

    const result = spawnSyncWithDeadline(
      process.execPath,
      [join(dir, "scripts", "run-db-tests.mjs")],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://dummy:dummy@localhost:1/dummy",
          TIMELINE_LOG: timelineLog,
        },
      },
    );

    const output = `${result.stdout}${result.stderr}`;
    expect(output, output).toContain("DB テストを実行します");
    expect(output, output).toContain("✔ DB テストも実行し、通りました。");
    expect(result.status, output).toBe(0);

    const timeline = parseTimeline(timelineLog);
    expect(timeline).toHaveLength(2);
    const [a, b] = timeline;

    expect(
      intervalsOverlap(a, b),
      `2つの区間が重なっている(並行に走った): ${JSON.stringify(timeline)}`,
    ).toBe(false);
  });
});
