import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/** CLI は子プロセスで起動する。`process.exit` と実ファイルの書き込みを伴うので import では測れない。本物の `packages/<pkg>/package.json` は書き換えず、複製した一時ディレクトリで走らせる。 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** @type {string | undefined} */
let sandbox;

afterEach(() => {
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "apply-release-version-"));
  cpSync(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });
  for (const target of PUBLISH_TARGETS) {
    cpSync(join(repoRoot, target.dir, "package.json"), join(dir, target.dir, "package.json"), {
      recursive: false,
      force: true,
      ...{},
    });
  }
  return dir;
}

function run(dir, env) {
  const outputPath = join(dir, "github-output");
  writeFileSync(outputPath, "");
  const result = spawnSyncWithDeadline(
    process.execPath,
    [join(dir, "scripts", "apply-release-version.mjs")],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath, ...env },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    githubOutput: readFileSync(outputPath, "utf8"),
  };
}

function versionsIn(dir) {
  return PUBLISH_TARGETS.map(
    (t) => JSON.parse(readFileSync(join(dir, t.dir, "package.json"), "utf8")).version,
  );
}

describe("apply-release-version.mjs（ADR 0070）", () => {
  it("publish 対象すべての version を tag の版へ書き換える", () => {
    sandbox = makeSandbox();
    const before = versionsIn(sandbox);

    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });

    expect(r.status, `EXIT=0 を期待した。stderr:\n${r.stderr}`).toBe(0);
    // 期待値の長さを直書きしない。publish 対象が増えたときに、一部しか見ないまま緑で通るのを防ぐ。
    const allNine = PUBLISH_TARGETS.map(() => "9.9.9");
    expect(versionsIn(sandbox)).toEqual(allNine);
    expect(before).not.toEqual(allNine);
  });

  it("$GITHUB_OUTPUT へ version と npm_tag を書く", () => {
    sandbox = makeSandbox();
    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });
    expect(r.githubOutput).toContain("version=9.9.9");
    expect(r.githubOutput).toContain("npm_tag=latest");
  });

  it("pre-release の Release では npm_tag が next になる", () => {
    sandbox = makeSandbox();
    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "true" });
    expect(r.githubOutput).toContain("npm_tag=next");
    expect(r.stdout).toContain("::warning::");
  });

  it("semver でない tag では EXIT=1 になり、package.json を書き換えない", () => {
    sandbox = makeSandbox();
    const before = versionsIn(sandbox);

    const r = run(sandbox, { RELEASE_TAG: "vfoo", GITHUB_PRERELEASE: "false" });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(versionsIn(sandbox), "落ちたのに書き換わっていた").toEqual(before);
  });

  it("RELEASE_TAG が無ければ EXIT=1 になる", () => {
    sandbox = makeSandbox();
    const r = run(sandbox, { RELEASE_TAG: "" });
    expect(r.status).toBe(1);
  });

  it("同じ版で2回走らせても同じ結果になる（冪等）", () => {
    sandbox = makeSandbox();
    run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });
    const once = versionsIn(sandbox);
    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });
    expect(r.status).toBe(0);
    expect(versionsIn(sandbox)).toEqual(once);
  });

  it("書き換えた package.json が prettier の整形と一致する", () => {
    sandbox = makeSandbox();
    run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });

    for (const target of PUBLISH_TARGETS) {
      const path = join(sandbox, target.dir, "package.json");
      const written = readFileSync(path, "utf8");
      const check = spawnSyncWithDeadline(
        process.execPath,
        [
          join(repoRoot, "node_modules", "prettier", "bin", "prettier.cjs"),
          // `--parser json` ではなく json-stringify で比べる。prettier は package.json に json-stringify を使い、json パーサは配列を1行へ畳む。
          "--stdin-filepath",
          "package.json",
        ],
        { input: written, encoding: "utf8" },
      );
      expect(check.status, `prettier が走らなかった: ${check.stderr}`).toBe(0);
      expect(check.stdout, `${target.name} の整形が prettier と違う`).toBe(written);
    }
  });
});
