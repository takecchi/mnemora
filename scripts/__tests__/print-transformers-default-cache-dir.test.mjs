import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { execFileSyncWithDeadline } from "./spawn-with-deadline.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repoRoot, "scripts/print-transformers-default-cache-dir.mjs");
function transformersPackageRoot(requireFrom) {
  // exports に ./package.json が無いので、入口を解決してから package.json まで上る。
  let dir = dirname(requireFrom.resolve("@huggingface/transformers"));
  while (
    !existsSync(join(dir, "package.json")) ||
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "@huggingface/transformers"
  ) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("@huggingface/transformers の package.json が見つからない");
    dir = parent;
  }
  return dir;
}
const pkgJsonPath = join(
  transformersPackageRoot(createRequire(join(repoRoot, "packages/local-embedding/package.json"))),
  "package.json",
);
const version = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;

describe("print-transformers-default-cache-dir.mjs（Issue #1004）", () => {
  it("packages/local-embedding が読み込む transformers.js の既定のキャッシュの場所と版を、$GITHUB_OUTPUT の形で出す", () => {
    const out = execFileSyncWithDeadline(process.execPath, [script], { encoding: "utf8" })
      .trim()
      .split("\n");
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(`version=${version}`);
    // 既定の場所は、その版の transformers.js のパッケージの中の `.cache/` である（4.2.0 の DEFAULT_CACHE_DIR）。
    expect(out[0]).toBe(`dir=${join(dirname(pkgJsonPath), "/.cache/")}`);
  });

  it("--plain では場所だけを出す", () => {
    const out = execFileSyncWithDeadline(process.execPath, [script, "--plain"], {
      encoding: "utf8",
    }).trim();
    expect(out).toBe(join(dirname(pkgJsonPath), "/.cache/"));
  });
});
