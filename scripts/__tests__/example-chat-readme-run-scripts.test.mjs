import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const README_PATH = "examples/chat/README.md";
const readme = readFileSync(join(repoRoot, README_PATH), "utf8");

const PACKAGE_DIRS = {
  "@mnemora/example-chat": "examples/chat",
  "@mnemora/postgres": "packages/postgres",
};

const RUN_REF = /pnpm --filter (@mnemora\/[a-z0-9-]+) run ([A-Za-z0-9:_-]+)/g;

/** @param {string} text */
function runRefs(text) {
  return [...text.matchAll(RUN_REF)].map((m) => ({ pkg: m[1], script: m[2] }));
}

/** @param {string} pkg */
function scriptsOf(pkg) {
  const dir = PACKAGE_DIRS[pkg];
  if (dir === undefined) return undefined;
  const manifest = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
  expect(manifest.name, `${dir}/package.json の name`).toBe(pkg);
  return manifest.scripts ?? {};
}

describe(`${README_PATH} の \`pnpm --filter … run X\` は、その package.json の scripts に在る`, () => {
  it("陽性対照: README から run の参照を拾えている（chat・compare・migrate を含む）", () => {
    const refs = runRefs(readme).map((r) => `${r.pkg} ${r.script}`);
    expect(refs).toContain("@mnemora/example-chat chat");
    expect(refs).toContain("@mnemora/example-chat compare");
    expect(refs).toContain("@mnemora/postgres migrate");
  });

  it("陽性対照: scripts に無い名前は見つからないと報告する", () => {
    const scripts = scriptsOf("@mnemora/example-chat");
    expect(Object.hasOwn(scripts, "no-such-script-for-readme-check")).toBe(false);
  });

  it("README が名指しする run X は、どれもそのパッケージの scripts に在る", () => {
    const missing = [];
    for (const { pkg, script } of runRefs(readme)) {
      const scripts = scriptsOf(pkg);
      if (scripts === undefined) {
        missing.push(`${pkg}（この歯の PACKAGE_DIRS に無いパッケージ。表に足すこと）`);
      } else if (!Object.hasOwn(scripts, script)) {
        missing.push(`${pkg} run ${script}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
