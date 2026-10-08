import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * `apply-release-version.mjs` の書き込みの境界を、fixture の package.json で測る。
 * 本物の package.json の形では通らない経路（入れ子の `"version"`・build metadata 付きの版・
 * 重複したキー・name の食い違い）を押さえる。publish 対象の一覧は fixture に差し替える。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const TARGET = { name: "@fx/a", dir: "packages/a" };

/** @type {string | undefined} */
let sandbox;

afterEach(() => {
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

/**
 * @param {string} manifestSource fixture の package.json の本文（そのまま書く）
 * @param {{ name: string, dir: string }} [target] publish 対象の一覧に載せる1件
 */
function makeSandbox(manifestSource, target = TARGET) {
  const dir = mkdtempSync(join(tmpdir(), "apply-release-version-fixture-"));
  mkdirSync(join(dir, "scripts"));
  for (const file of ["apply-release-version.mjs", "release-version.mjs"]) {
    cpSync(join(repoRoot, "scripts", file), join(dir, "scripts", file));
  }
  writeFileSync(
    join(dir, "scripts", "publish-targets.mjs"),
    `export const PUBLISH_TARGETS = ${JSON.stringify([target])};\n`,
  );
  mkdirSync(join(dir, TARGET.dir), { recursive: true });
  writeFileSync(join(dir, TARGET.dir, "package.json"), manifestSource);
  return dir;
}

function run(dir, tag) {
  const result = spawnSyncWithDeadline(
    process.execPath,
    [join(dir, "scripts", "apply-release-version.mjs")],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "", RELEASE_TAG: tag, GITHUB_PRERELEASE: "false" },
    },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

const manifestIn = (dir) => readFileSync(join(dir, TARGET.dir, "package.json"), "utf8");

describe("トップレベルの `version` の行だけを差し替える", () => {
  it('入れ子の `"version"` が先に在っても掴まず、トップレベルの行を差し替える', () => {
    const source = [
      "{",
      '  "name": "@fx/a",',
      '  "meta": {',
      '    "version": "1.0.0"',
      "  },",
      '  "version": "1.0.0"',
      "}",
      "",
    ].join("\n");
    sandbox = makeSandbox(source);

    const r = run(sandbox, "v2.0.0");

    expect(r.status, `exit 0 を期待した。stderr:\n${r.stderr}`).toBe(0);
    const written = JSON.parse(manifestIn(sandbox));
    expect(written.version).toBe("2.0.0");
    expect(written.meta.version).toBe("1.0.0");
  });

  it("元の版に正規表現の記号（build metadata の `+`）が在っても、その行を差し替えられる", () => {
    sandbox = makeSandbox('{\n  "name": "@fx/a",\n  "version": "1.0.0+b1"\n}\n');

    const r = run(sandbox, "v2.0.0");

    expect(r.status, `exit 0 を期待した。stderr:\n${r.stderr}`).toBe(0);
    expect(JSON.parse(manifestIn(sandbox)).version).toBe("2.0.0");
  });
});

describe("書けたことを確かめられないときは、exit 1 で止める", () => {
  it("publish 対象の name と package.json の name が食い違うときは、書き換えずに止める", () => {
    const source = '{\n  "name": "@fx/other",\n  "version": "1.0.0"\n}\n';
    sandbox = makeSandbox(source);

    const r = run(sandbox, "v2.0.0");

    expect(r.status).toBe(1);
    expect(manifestIn(sandbox)).toBe(source);
  });

  it("書いたあとで読み直した版が tag の版と違う（`version` のキーが2つある）", () => {
    // JSON.parse は後ろのキーを採る。差し替えは前の行に当たるので、読み直すと古い版のまま。
    sandbox = makeSandbox(
      '{\n  "name": "@fx/a",\n  "version": "1.0.0",\n  "version": "1.0.0"\n}\n',
    );

    expect(run(sandbox, "v2.0.0").status).toBe(1);
  });
});
