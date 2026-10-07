import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * #365・#436（ADR 0179・0200）の確かめ直し（Issue #1877）。`adr-renumber.mjs` を、追加された ADR が1本も無い作業木で走らせると、
 * 引数なしでも `--check` でも exit 0（何もしない）。`adr-renumber-cli.test.mjs` はこの経路を走らせていなかったため、
 * 「追加が無いのに exit 1」にしても緑だった。
 */

const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
const tmpRoots = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "adr-renumber-nothing-"));
  tmpRoots.push(dir);
  mkdirSync(join(dir, "scripts"));
  for (const f of ["adr-renumber.mjs", "adr-renumber-lib.mjs", "generate-adr-index-lib.mjs"]) {
    copyFileSync(join(scriptsDir, f), join(dir, "scripts", f));
  }
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "docs/decisions"), { recursive: true });
  writeFileSync(join(dir, "docs/decisions/0001-a.md"), "# ADR 0001: a\n");
  writeFileSync(join(dir, "docs/decisions/README.md"), "# index\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function run(dir, args) {
  return spawnSync("node", ["scripts/adr-renumber.mjs", ...args], { cwd: dir, encoding: "utf8" });
}

describe("追加された ADR が1本も無いとき", () => {
  it("引数なしは exit 0 で、何も書き換えない", () => {
    const dir = makeRepo();
    const r = run(dir, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("新しく追加された ADR ファイルはありません");
    expect(readFileSync(join(dir, "docs/decisions/0001-a.md"), "utf8")).toBe("# ADR 0001: a\n");
  });

  it("--check も exit 0", () => {
    const dir = makeRepo();
    const r = run(dir, ["--check"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("新しく追加された ADR ファイルはありません");
  });
});
