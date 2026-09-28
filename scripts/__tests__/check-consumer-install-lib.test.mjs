import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_ENTRY_POINTS,
  buildSmokeCjs,
  buildSmokeMjs,
  buildSmokeTs,
  buildTsconfig,
  compareEntryPoints,
  entryPointsFromExports,
} from "../check-consumer-install-lib.mjs";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";

/**
 * ⭐ **この歯が測っているもの**（ADR 0346）
 *
 * `scripts/check-consumer-install.mjs`（出荷6パッケージを repo の外に入れて確かめる道具）の、
 * ネットワークを使わない部品。道具そのもの（pack → npm install → tsc → node）は registry に依存するので、
 * 既定の CI では走らせない（リリース前に人が打つ。`docs/release-v1.md` 0.11）。
 *
 * ⚠ **ここは作業ツリーの package.json を読む**——tarball ではない。道具の本体は tarball の中の
 * package.json を読む。ここで見るのは、一覧（`EXPECTED_ENTRY_POINTS`）と作業ツリーの `exports` が
 * いま揃っていること（入口を足した・消した PR で、一覧の更新漏れに CI で気づけるように）である。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("entryPointsFromExports", () => {
  it("`.` はパッケージ名、`./x` は `名前/x` になり、`./package.json` は除く", () => {
    expect(
      entryPointsFromExports({
        name: "@a/b",
        exports: { ".": {}, "./fixtures": {}, "./package.json": "./package.json" },
      }),
    ).toEqual(["@a/b", "@a/b/fixtures"]);
  });

  it("exports が無い・文字列のときはパッケージ名だけ", () => {
    expect(entryPointsFromExports({ name: "@a/b" })).toEqual(["@a/b"]);
    expect(entryPointsFromExports({ name: "@a/b", exports: "./index.js" })).toEqual(["@a/b"]);
  });
});

describe("compareEntryPoints", () => {
  it("消えた入口と、一覧に無い入口の両方を返す", () => {
    expect(compareEntryPoints(["a", "a/f"], ["a", "a/g"])).toEqual({
      missing: ["a/f"],
      unexpected: ["a/g"],
    });
    expect(compareEntryPoints(["a"], ["a"])).toEqual({ missing: [], unexpected: [] });
  });
});

describe("EXPECTED_ENTRY_POINTS と作業ツリーの exports", () => {
  it("PUBLISH_TARGETS の各 package.json の exports から列挙した入口と、両向きで一致する", () => {
    const actual = PUBLISH_TARGETS.flatMap((t) =>
      entryPointsFromExports(JSON.parse(readFileSync(`${repoRoot}${t.dir}/package.json`, "utf8"))),
    );
    expect(compareEntryPoints(EXPECTED_ENTRY_POINTS, actual)).toEqual({
      missing: [],
      unexpected: [],
    });
  });
});

describe("生成するファイル", () => {
  it("smoke.ts はすべての入口を import し、使う", () => {
    const src = buildSmokeTs(["@a/b", "@a/b/f"]);
    expect(src).toContain('import * as e0 from "@a/b";');
    expect(src).toContain('import * as e1 from "@a/b/f";');
    expect(src).toContain("export const namespaces = [e0, e1];");
  });

  it("smoke.mjs は解決先が node_modules の配下であることと、export の有無を見る", () => {
    const src = buildSmokeMjs(["@a/b"]);
    expect(src).toContain('["@a/b"]');
    expect(src).toContain('"/node_modules/"');
    expect(src).toContain("Object.keys(mod).length === 0");
  });

  it("smoke.cjs は require で読み、解決先が node_modules の配下であることと、export の有無を見る", () => {
    const src = buildSmokeCjs(["@a/b"]);
    expect(src).toContain('["@a/b"]');
    expect(src).toContain("require.resolve(spec)");
    expect(src).toContain("require(spec)");
    expect(src).not.toContain("import(");
    expect(src).toContain('"/node_modules/"');
    expect(src).toContain("Object.keys(mod).length === 0");
  });

  it("tsconfig は node16 と bundler で module を変え、どちらも strict・skipLibCheck: true", () => {
    const n = JSON.parse(buildTsconfig("node16")).compilerOptions;
    const b = JSON.parse(buildTsconfig("bundler")).compilerOptions;
    expect([n.module, n.moduleResolution, b.module, b.moduleResolution]).toEqual([
      "Node16",
      "node16",
      "ESNext",
      "bundler",
    ]);
    expect([n.strict, n.skipLibCheck, b.strict, b.skipLibCheck]).toEqual([true, true, true, true]);
  });
});
