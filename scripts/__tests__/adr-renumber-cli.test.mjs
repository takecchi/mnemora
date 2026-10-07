import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function write(dir, path, body) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
}

function makeRepo(setup) {
  const dir = mkdtempSync(join(tmpdir(), "adr-renumber-cli-"));
  tmpRoots.push(dir);
  mkdirSync(join(dir, "scripts"));
  for (const f of ["adr-renumber.mjs", "adr-renumber-lib.mjs", "generate-adr-index-lib.mjs"]) {
    copyFileSync(join(scriptsDir, f), join(dir, "scripts", f));
  }
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  write(dir, "docs/decisions/0001-a.md", ADR("0001", "a"));
  write(dir, "docs/decisions/0002-c.md", ADR("0002", "c"));
  write(dir, "docs/decisions/README.md", "# index\n");
  write(dir, "docs/inherited.md", "継承した行: ADR 0001 は main の正当な言及\n途中の行\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  setup?.(dir);
  git(dir, "add", "-A");
  return dir;
}

function fakeGh(root, prs, files = {}) {
  const bin = join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  const lines =
    prs === null
      ? ["exit 1"]
      : [
          'if [ "$2" = "list" ]; then',
          ...prs.map((n) => `  echo ${n}`),
          "  exit 0",
          "fi",
          'if [ "$2" = "view" ]; then',
          ...Object.entries(files).flatMap(([n, fs]) => [
            `  if [ "$3" = "${n}" ]; then`,
            ...fs.map((f) => `    echo ${f}`),
            "  fi",
          ]),
          "  exit 0",
          "fi",
          "exit 1",
        ];
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${lines.join("\n")}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function run(dir, args = [], ghBin = null) {
  const bin = ghBin ?? fakeGh(dir, null);
  return spawnSync("node", ["scripts/adr-renumber.mjs", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

const read = (dir, p) => readFileSync(join(dir, p), "utf8");

describe("adr-renumber.mjs（引数なし）は、付け替えて、このブランチが足した行だけを書き換える", () => {
  const repo = () =>
    makeRepo((dir) => {
      write(dir, "docs/decisions/0001-b.md", ADR("0001", "b"));
      write(
        dir,
        "docs/inherited.md",
        "継承した行: ADR 0001 は main の正当な言及\n途中の行\n新しい行: ADR 0001（0001-b）を見よ\n",
      );
      write(
        dir,
        "docs/decisions/0002-c.md",
        `${ADR("0002", "c")}追記: 0002-c と ADR 0002 は自分自身\n`,
      );
    });

  it("衝突した ADR を次の空き番号へ改名し、見出しと参照を書き換え、継承した行は触らない", () => {
    const dir = repo();
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "docs/decisions/0003-b.md"))).toBe(true);
    expect(existsSync(join(dir, "docs/decisions/0001-b.md"))).toBe(false);
    expect(read(dir, "docs/decisions/0003-b.md")).toContain("# ADR 0003: b");
    const inherited = read(dir, "docs/inherited.md");
    expect(inherited).toBe(
      "継承した行: ADR 0001 は main の正当な言及\n途中の行\n新しい行: ADR 0003（0003-b）を見よ\n",
    );
    expect(existsSync(join(dir, "docs/decisions/0002-c.md"))).toBe(true);
    expect(read(dir, "docs/decisions/0002-c.md")).toContain("追記: 0002-c と ADR 0002 は自分自身");
    expect(read(dir, "docs/decisions/0001-a.md")).toBe(ADR("0001", "a"));
  });

  it("書き換えたファイルは、末尾の改行を1つも増やさず減らさない", () => {
    const dir = repo();
    run(dir);
    expect(read(dir, "docs/inherited.md").endsWith("を見よ\n")).toBe(true);
    expect(read(dir, "docs/inherited.md").endsWith("\n\n")).toBe(false);
  });

  it("付け替えたら、PR タイトルと本文の両方を直す警告を stderr に出す（Issue #405）", () => {
    const dir = repo();
    const r = run(dir);
    expect(r.stderr).toContain("ADR 0001 -> ADR 0003");
    expect(r.stderr).toContain("PR タイトルと本文");
    expect(r.stdout).toContain("git mv docs/decisions/0001-b.md docs/decisions/0003-b.md");
  });

  it("衝突が無ければ何も変えず、警告も出さない", () => {
    const dir = makeRepo((d) => write(d, "docs/decisions/0003-new.md", ADR("0003", "new")));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "docs/decisions/0003-new.md"))).toBe(true);
    expect(r.stderr).not.toContain("PR タイトルと本文");
    expect(r.stdout).toContain("衝突なし");
  });

  it("NUL を含むファイル（バイナリ）は、git が text と見なす位置より後ろに NUL があっても書き換えない", () => {
    const dir = makeRepo((d) => {
      write(d, "docs/decisions/0001-b.md", ADR("0001", "b"));
      // git は先頭 8000 バイトに NUL が無ければ text と見なす。その後ろに NUL を置く
      const body = `${"x".repeat(9000)}\nADR 0001 を見よ\n\0\n`;
      write(d, "docs/blob.txt", body);
    });
    const before = readFileSync(join(dir, "docs/blob.txt"));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "docs/blob.txt")).equals(before)).toBe(true);
  });

  it("略記の連なりの2番目以降に旧番号が残ったら、書き換えず exit 1 で人に渡す（Issue #615）", () => {
    const dir = makeRepo((d) => {
      write(d, "docs/decisions/0001-b.md", ADR("0001", "b"));
      write(d, "docs/chain.md", "参照: ADR 0009 / 0001 を見よ\n");
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("付け替えられずに残った参照が 1 件");
    expect(r.stderr).toContain("docs/chain.md:1");
    expect(read(dir, "docs/chain.md")).toBe("参照: ADR 0009 / 0001 を見よ\n");
  });

  it("同じ行で何かが書き換わっても、連なりの2番目に残った旧番号は見逃さない（PR #614 の形）", () => {
    const dir = makeRepo((d) => {
      write(d, "docs/decisions/0001-b.md", ADR("0001", "b"));
      write(d, "docs/chain.md", "ADR 0001 と、ADR 0009 / 0001 を見よ\n");
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(read(dir, "docs/chain.md")).toBe("ADR 0003 と、ADR 0009 / 0001 を見よ\n");
  });
});

describe("adr-renumber.mjs --check", () => {
  it("衝突があれば exit 1 で、旧番号と次の空き番号を名指しする", () => {
    const dir = makeRepo((d) => write(d, "docs/decisions/0001-b.md", ADR("0001", "b")));
    const r = run(dir, ["--check"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("衝突あり: 1 件");
    expect(r.stderr).toContain("0001-b.md");
    expect(r.stderr).toContain("次の空き番号: 0003");
    expect(existsSync(join(dir, "docs/decisions/0001-b.md"))).toBe(true);
  });

  it("衝突が無ければ exit 0", () => {
    const dir = makeRepo((d) => write(d, "docs/decisions/0003-new.md", ADR("0003", "new")));
    const r = run(dir, ["--check"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("衝突なし: docs/decisions/0003-new.md");
  });

  it("新しく足した ADR が無ければ exit 0", () => {
    const dir = makeRepo();
    const r = run(dir, ["--check"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("新しく追加された ADR ファイルはありません");
  });
});

describe("adr-renumber.mjs の引数", () => {
  it("--check と --next は同時に指定できない（exit 3）", () => {
    const dir = makeRepo();
    expect(run(dir, ["--check", "--next"]).status).toBe(3);
  });
});

describe("adr-renumber.mjs --next は origin/main・他のリモートブランチ・open な PR の主張を全部数える", () => {
  const withBranch = (dir) => {
    write(dir, "docs/decisions/0005-other.md", ADR("0005", "other"));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "other");
    git(dir, "update-ref", "refs/remotes/origin/feature", "HEAD");
    git(dir, "reset", "-q", "--hard", "origin/main");
  };

  it("他のリモートブランチの主張を数える（main の最大 0002 の次ではなく 0006）", () => {
    const dir = makeRepo();
    withBranch(dir);
    const r = run(dir, ["--next"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("origin/main の ADR 数: 2");
    expect(r.stdout).toContain("見た他のリモートブランチ: 1 本");
    expect(r.stdout).toContain(": 0006");
  });

  it("open な PR の主張を数える（0010 の次の 0011）", () => {
    const dir = makeRepo();
    const bin = fakeGh(dir, ["7"], { 7: ["docs/decisions/0010-pr.md", "README.md"] });
    const r = run(dir, ["--next"], bin);
    expect(r.stdout).toContain("1 本の ADR 主張");
    expect(r.stdout).toContain(": 0011");
  });

  it("gh が使えなければ、静かに劣化せず告知する", () => {
    const dir = makeRepo();
    const r = run(dir, ["--next"]);
    expect(r.stderr).toContain("`gh` が使えないため");
    expect(r.stdout).toContain("(gh 不可のため無し)");
    expect(r.stdout).toContain(": 0003");
  });
});
