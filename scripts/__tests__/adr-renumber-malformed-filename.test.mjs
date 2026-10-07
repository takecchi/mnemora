import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
const tmpRoots = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const ADR = (n, t) => `# ADR ${n}: ${t}\n\n- **状態**: 採用 (2026-10)\n`;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo({ extra = [], mainExtra = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "adr-renumber-"));
  tmpRoots.push(dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "docs/decisions"), { recursive: true });
  for (const f of ["adr-renumber.mjs", "adr-renumber-lib.mjs", "generate-adr-index-lib.mjs"]) {
    copyFileSync(join(scriptsDir, f), join(dir, "scripts", f));
  }
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "docs/decisions/0001-a.md"), ADR("0001", "a"));
  writeFileSync(join(dir, "docs/decisions/README.md"), "# index\n");
  for (const [path, body] of mainExtra) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "docs/decisions/0001-b.md"), ADR("0001", "b"));
  for (const [path, body] of extra) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "-A");
  return dir;
}

function runRenumber(dir, ...args) {
  return spawnSync("node", ["scripts/adr-renumber.mjs", ...args], { cwd: dir, encoding: "utf8" });
}

function snapshot(dir) {
  return {
    files: readdirSync(join(dir, "docs/decisions")).sort(),
    b: readFileSync(
      join(
        dir,
        "docs/decisions",
        readdirSync(join(dir, "docs/decisions")).includes("0001-b.md") ? "0001-b.md" : "README.md",
      ),
      "utf8",
    ),
    status: git(dir, "status", "--short"),
  };
}

const BAD_ADDED = [
  "adr-0538-x.md",
  "ADR-0538-x.md",
  "538-x.md",
  "05380-x.md",
  "0538_x.md",
  "0538.md",
  "0534-changelog-1.3.0-x.md",
  "notes.md",
];

describe("adr-renumber.mjs: 名前の形が外れた ADR は、書き換える前に失敗する（ADR 0540）", () => {
  for (const bad of BAD_ADDED) {
    it(`追加された ${bad}: 既定（書き換える）モードも --check も失敗し、何も変えない`, () => {
      const dir = makeRepo({ extra: [[`docs/decisions/${bad}`, ADR("0538", "x")]] });
      const before = snapshot(dir);
      const apply = runRenumber(dir);
      expect(apply.status).not.toBe(0);
      expect(apply.stderr).toContain(bad);
      expect(snapshot(dir)).toEqual(before);
      const check = runRenumber(dir, "--check");
      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain(bad);
      expect(snapshot(dir)).toEqual(before);
    });
  }

  it("origin/main の側にある形の外れた名前でも、書き換える前に失敗する", () => {
    const dir = makeRepo({ mainExtra: [["docs/decisions/adr-0099-old.md", ADR("0099", "old")]] });
    const before = snapshot(dir);
    const r = runRenumber(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("adr-0099-old.md");
    expect(snapshot(dir)).toEqual(before);
  });

  it("陰性対照: 形が正しければ、衝突した ADR を付け替える（失敗させすぎていない）", () => {
    const dir = makeRepo({
      extra: [
        ["docs/decisions/TEMPLATE.md", "# template\n"],
        ["docs/decisions/notes.txt", "x"],
        ["docs/decisions/img/diagram.md", "# 下位ディレクトリの中は対象外\n"],
      ],
    });
    const r = runRenumber(dir);
    expect(r.stderr).not.toContain("形から外れています");
    expect(r.status).toBe(0);
    expect(readdirSync(join(dir, "docs/decisions"))).toContain("0002-b.md");
  });
});
