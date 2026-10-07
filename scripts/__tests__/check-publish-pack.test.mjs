import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findWorkspaceProtocolViolations,
  findMissingEntryPoints,
  findMissingReadme,
  findVersionViolations,
  findVersionSkewViolations,
  findPublishAccessViolations,
  findOrphanedSourceMaps,
  findLicenseViolations,
  findPrivateViolations,
  findExactPinnedDependencyViolations,
  EXACT_PINNED_DEPENDENCY_EXEMPTIONS,
  NEVER_PUBLISHED_TARGETS,
} from "../publish-pack-checks.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../check-publish-pack.mjs", import.meta.url));

/** publish 対象の全件を直書きで持つ（`publish-targets.test.mjs` が `PUBLISH_TARGETS` との一致を検査する）。 */
const PUBLISH_TARGETS = [
  { name: "@mnemora/core", dir: "packages/core" },
  { name: "@mnemora/testkit", dir: "packages/testkit" },
  { name: "@mnemora/postgres", dir: "packages/postgres" },
  { name: "@mnemora/openai", dir: "packages/openai" },
  { name: "@mnemora/anthropic", dir: "packages/anthropic" },
  { name: "@mnemora/local-embedding", dir: "packages/local-embedding" },
  { name: "@mnemora/bullmq", dir: "packages/bullmq" },
];

function readManifest(dir) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${dir}/package.json`, import.meta.url)), "utf8"),
  );
}

describe("publish 対象パッケージの package.json（静的）", () => {
  for (const target of PUBLISH_TARGETS) {
    describe(target.name, () => {
      const manifest = readManifest(target.dir);

      if (NEVER_PUBLISHED_TARGETS.has(target.name)) {
        // publish.yml は門の前に全対象の version を tag の版へ書き換える。0.0.0 だけを許すと、Release のたびに publish ジョブがここで落ちる。
        it("git 上の version は 0.0.0 のままでよい（publish 時は tag の版＝core と同じ版）", () => {
          const coreVersion = readManifest("packages/core").version;
          expect(["0.0.0", coreVersion]).toContain(manifest.version);
        });
      } else {
        it("version が 0.0.0 のままではない", () => {
          expect(manifest.version).not.toBe("0.0.0");
          expect(manifest.version).toBeTruthy();
        });
      }

      it("prepack が dist を作り直す（`pnpm pack` が空の tarball を出す穴を塞ぐ本体）", () => {
        expect(manifest.scripts?.prepack).toBe("pnpm run build");
      });

      it("publishConfig.access が public", () => {
        expect(manifest.publishConfig?.access).toBe("public");
      });

      it("license が MIT である（UNLICENSED 等の他の値ではない）", () => {
        expect(manifest.license).toBe("MIT");
      });

      it("engines.node が設定されている", () => {
        expect(manifest.engines?.node).toBeTruthy();
      });

      it("repository が packages/<name> を指している", () => {
        expect(manifest.repository?.type).toBe("git");
        expect(manifest.repository?.url).toBe("git+https://github.com/takecchi/mnemora.git");
        expect(manifest.repository?.directory).toBe(target.dir);
      });

      it("homepage が設定されている", () => {
        expect(manifest.homepage).toContain("github.com/takecchi/mnemora");
        expect(manifest.homepage).toContain(target.dir);
      });

      it("bugs.url が設定されている", () => {
        expect(manifest.bugs?.url).toBe("https://github.com/takecchi/mnemora/issues");
      });

      it("private が立っていない（ADR 0066 で publish を始める判断が下った）", () => {
        expect(manifest.private).toBeUndefined();
      });

      it("exports の . が types と default を持ち、main / types と同じ先を指す", () => {
        expect(manifest.exports?.["."]?.types).toBe(manifest.types);
        expect(manifest.exports?.["."]?.default).toBe(manifest.main);
      });

      it("exports が ./package.json を通す（自分の manifest を読む道具のため）", () => {
        expect(manifest.exports?.["./package.json"]).toBe("./package.json");
      });

      it("dependencies が完全固定でない（除外分を除く）", () => {
        const violations = findExactPinnedDependencyViolations(
          manifest,
          EXACT_PINNED_DEPENDENCY_EXEMPTIONS[target.name] ?? [],
        );
        expect(violations).toEqual([]);
      });
    });
  }

  it("publish 対象すべてで version が揃っている（NEVER_PUBLISHED_TARGETS を除く）", () => {
    const versions = new Set(
      PUBLISH_TARGETS.filter((t) => !NEVER_PUBLISHED_TARGETS.has(t.name)).map(
        (t) => readManifest(t.dir).version,
      ),
    );
    expect(versions.size).toBe(1);
  });

  // 一覧に戻しても上の2つの it は緑のままなので、一覧が空であることを直に見る。
  it("NEVER_PUBLISHED_TARGETS は空である（@mnemora/bullmq を含め、全対象が version 検査を受ける）", () => {
    expect([...NEVER_PUBLISHED_TARGETS]).toEqual([]);
  });
});

describe("publish-pack-checks.mjs の判定関数（合成フィクスチャに対する変異の歯）", () => {
  describe("findWorkspaceProtocolViolations", () => {
    it("dependencies の workspace: を検出する", () => {
      const violations = findWorkspaceProtocolViolations({
        dependencies: { "@mnemora/core": "workspace:*" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("dependencies.@mnemora/core");
      expect(violations[0]).toContain("workspace:*");
    });

    it("実版に置換されていれば検出しない", () => {
      const violations = findWorkspaceProtocolViolations({
        dependencies: { "@mnemora/core": "0.1.0" },
      });
      expect(violations).toEqual([]);
    });

    it("peerDependencies の workspace: も検出する", () => {
      const violations = findWorkspaceProtocolViolations({
        peerDependencies: { "@mnemora/core": "workspace:^0.1.0" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("peerDependencies.@mnemora/core");
    });

    it("optionalDependencies の workspace: も検出する", () => {
      const violations = findWorkspaceProtocolViolations({
        optionalDependencies: { "@mnemora/core": "workspace:*" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("optionalDependencies.@mnemora/core");
    });
  });

  describe("findExactPinnedDependencyViolations", () => {
    it("完全固定（x.y.z）の dependencies を検出する", () => {
      const violations = findExactPinnedDependencyViolations({
        dependencies: { zod: "4.5.4" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("dependencies.zod");
      expect(violations[0]).toContain("4.5.4");
    });

    it("^ で始まる範囲指定は検出しない", () => {
      const violations = findExactPinnedDependencyViolations({
        dependencies: { zod: "^4.5.4" },
      });
      expect(violations).toEqual([]);
    });

    it("~ / >= / * / workspace: / x 範囲も検出しない", () => {
      const violations = findExactPinnedDependencyViolations({
        dependencies: {
          a: "~4.5.4",
          b: ">=4.5.4",
          c: "*",
          d: "workspace:^",
          e: "4.5.x",
        },
      });
      expect(violations).toEqual([]);
    });

    it("prerelease / build metadata 付きの完全固定も検出する", () => {
      const violations = findExactPinnedDependencyViolations({
        dependencies: { a: "1.2.3-beta.1", b: "1.2.3+build.5" },
      });
      expect(violations).toHaveLength(2);
    });

    it("devDependencies / peerDependencies / optionalDependencies は対象外", () => {
      const violations = findExactPinnedDependencyViolations({
        devDependencies: { zod: "4.5.4" },
        peerDependencies: { zod: "4.5.4" },
        optionalDependencies: { zod: "4.5.4" },
      });
      expect(violations).toEqual([]);
    });

    it("exemptDependencyNames に載っている依存は完全固定でも検出しない", () => {
      const violations = findExactPinnedDependencyViolations(
        { dependencies: { "drizzle-orm": "0.45.2", zod: "4.5.4" } },
        ["drizzle-orm"],
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("dependencies.zod");
    });

    it("dependencies が無ければ0件", () => {
      expect(findExactPinnedDependencyViolations({})).toEqual([]);
    });
  });

  describe("findMissingEntryPoints", () => {
    /** @type {string | undefined} */
    let fixtureDir;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("main が実在すれば0件、消せば1件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-main-"));
      writeFileSync(join(fixtureDir, "index.js"), "export {};\n");

      const present = findMissingEntryPoints({ main: "./index.js" }, fixtureDir);
      expect(present).toEqual([]);

      const missing = findMissingEntryPoints({ main: "./missing.js" }, fixtureDir);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("main");
      expect(missing[0]).toContain("./missing.js");
    });

    it("bin（オブジェクト形式）が実在すれば0件、消せば1件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-bin-obj-"));
      mkdirSync(join(fixtureDir, "bin"));
      writeFileSync(join(fixtureDir, "bin", "migrate.js"), "#!/usr/bin/env node\n");

      const present = findMissingEntryPoints(
        { bin: { "mnemora-postgres-migrate": "./bin/migrate.js" } },
        fixtureDir,
      );
      expect(present).toEqual([]);

      const missing = findMissingEntryPoints(
        { bin: { "mnemora-postgres-migrate": "./bin/does-not-exist.js" } },
        fixtureDir,
      );
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("bin.mnemora-postgres-migrate");
    });

    it("bin（文字列形式）が実在すれば0件、消せば1件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-bin-str-"));
      writeFileSync(join(fixtureDir, "cli.js"), "#!/usr/bin/env node\n");

      const present = findMissingEntryPoints({ bin: "./cli.js" }, fixtureDir);
      expect(present).toEqual([]);

      const missing = findMissingEntryPoints({ bin: "./missing-cli.js" }, fixtureDir);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("bin");
      expect(missing[0]).toContain("./missing-cli.js");
    });

    it("exports の条件付き形（types / default）が実在すれば0件、片方を消せばその1件だけ検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-exports-cond-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(join(fixtureDir, "dist", "index.js"), "export {};\n");
      writeFileSync(join(fixtureDir, "dist", "index.d.ts"), "export {};\n");

      const manifest = {
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./package.json": "./package.json",
        },
      };
      writeFileSync(join(fixtureDir, "package.json"), "{}\n");
      expect(findMissingEntryPoints(manifest, fixtureDir)).toEqual([]);

      const brokenDefault = findMissingEntryPoints(
        {
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/does-not-exist.js" },
            "./package.json": "./package.json",
          },
        },
        fixtureDir,
      );
      expect(brokenDefault).toHaveLength(1);
      expect(brokenDefault[0]).toContain("exports.[default]");
      expect(brokenDefault[0]).toContain("./dist/does-not-exist.js");
    });

    it("exports の subpath ごとにラベルが分かれる（どの口が欠けたか読める）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-exports-subpath-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(join(fixtureDir, "dist", "index.js"), "export {};\n");

      const missing = findMissingEntryPoints(
        {
          exports: {
            ".": "./dist/index.js",
            "./migrations": "./migrations/index.js",
          },
        },
        fixtureDir,
      );
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("exports./migrations");
      expect(missing[0]).not.toContain("exports.[");
    });

    it("exports の値が null（意図的に塞いだ subpath）なら検出しない", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-exports-null-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(join(fixtureDir, "dist", "index.js"), "export {};\n");

      expect(
        findMissingEntryPoints(
          { exports: { ".": "./dist/index.js", "./internal": null } },
          fixtureDir,
        ),
      ).toEqual([]);
    });

    it("exports の配列形は1つでも実在すれば検出せず、全滅なら1件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-exports-array-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(join(fixtureDir, "dist", "index.js"), "export {};\n");

      expect(
        findMissingEntryPoints(
          { exports: { ".": ["./dist/nope.js", "./dist/index.js"] } },
          fixtureDir,
        ),
      ).toEqual([]);

      const allMissing = findMissingEntryPoints(
        { exports: { ".": ["./dist/nope.js", "./dist/also-nope.js"] } },
        fixtureDir,
      );
      expect(allMissing).toHaveLength(1);
      expect(allMissing[0]).toContain("のどれも実在しない");
    });

    it("exports が無い manifest では exports について何も検出しない（後方互換）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-exports-absent-"));
      writeFileSync(join(fixtureDir, "index.js"), "export {};\n");

      expect(findMissingEntryPoints({ main: "./index.js" }, fixtureDir)).toEqual([]);
    });
  });

  describe("findMissingReadme", () => {
    /** @type {string | undefined} */
    let fixtureDir;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("README.md が実在すれば検出しない", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-readme-ok-"));
      writeFileSync(join(fixtureDir, "README.md"), "# hello\n");

      expect(findMissingReadme(fixtureDir)).toEqual([]);
    });

    it("README.md が無ければ検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-readme-missing-"));

      const violations = findMissingReadme(fixtureDir);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("README.md が tarball に入っていません");
    });
  });

  describe("findVersionViolations（検査2・単一パッケージ側。Issue #174）", () => {
    it("version が 0.0.0 なら検出する", () => {
      const violations = findVersionViolations({ version: "0.0.0" });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("0.0.0");
    });

    it("version が未設定（フィールド自体が無い）なら検出する", () => {
      const violations = findVersionViolations({});
      expect(violations).toHaveLength(1);
    });

    it("version が空文字列なら検出する", () => {
      const violations = findVersionViolations({ version: "" });
      expect(violations).toHaveLength(1);
    });

    it("version が 0.1.0 なら検出しない", () => {
      expect(findVersionViolations({ version: "0.1.0" })).toEqual([]);
    });

    it("version が 0.0.1 なら検出しない（隣の値を通す）", () => {
      expect(findVersionViolations({ version: "0.0.1" })).toEqual([]);
    });

    it("version が 1.0.0-rc.1 なら検出しない（prerelease を弾かない）", () => {
      expect(findVersionViolations({ version: "1.0.0-rc.1" })).toEqual([]);
    });
  });

  describe("findVersionSkewViolations（検査2・publish 対象をまたぐ側。Issue #174）", () => {
    it("6件すべて同じ版なら検出しない", () => {
      const versions = [
        { name: "@mnemora/core", version: "0.1.1" },
        { name: "@mnemora/testkit", version: "0.1.1" },
        { name: "@mnemora/openai", version: "0.1.1" },
        { name: "@mnemora/anthropic", version: "0.1.1" },
        { name: "@mnemora/postgres", version: "0.1.1" },
        { name: "@mnemora/local-embedding", version: "0.1.1" },
      ];
      expect(findVersionSkewViolations(versions, 6)).toEqual([]);
    });

    it("6件のうち1件だけ別の版なら検出する", () => {
      const versions = [
        { name: "@mnemora/core", version: "0.1.1" },
        { name: "@mnemora/testkit", version: "0.1.1" },
        { name: "@mnemora/openai", version: "0.1.1" },
        { name: "@mnemora/anthropic", version: "0.1.1" },
        { name: "@mnemora/postgres", version: "0.1.1" },
        { name: "@mnemora/local-embedding", version: "0.1.2" },
      ];
      const violations = findVersionSkewViolations(versions, 6);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("@mnemora/local-embedding@0.1.2");
      expect(violations[0]).toContain("@mnemora/core@0.1.1");
    });

    /** 欠けた1件は `findVersionViolations` が別に報告済みなので、ここでは二重に報告しない（意図）。 */
    it("5件しか集まっておらず版がバラバラでも検出しない（欠けた1件は別の違反として既に報告済み）", () => {
      const versions = [
        { name: "@mnemora/core", version: "0.1.1" },
        { name: "@mnemora/testkit", version: "0.1.2" },
        { name: "@mnemora/openai", version: "0.1.3" },
        { name: "@mnemora/anthropic", version: "0.1.1" },
        { name: "@mnemora/postgres", version: "0.1.1" },
      ];
      expect(findVersionSkewViolations(versions, 6)).toEqual([]);
    });

    it("空配列なら検出しない", () => {
      expect(findVersionSkewViolations([], 6)).toEqual([]);
    });
  });

  describe("findPublishAccessViolations（検査5。Issue #174）", () => {
    it("publishConfig.access が restricted なら検出する", () => {
      const violations = findPublishAccessViolations({
        publishConfig: { access: "restricted" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("restricted");
    });

    it("publishConfig 自体が無ければ検出する", () => {
      const violations = findPublishAccessViolations({});
      expect(violations).toHaveLength(1);
    });

    it("publishConfig はあるが access が無ければ検出する", () => {
      const violations = findPublishAccessViolations({ publishConfig: {} });
      expect(violations).toHaveLength(1);
    });

    it("publishConfig.access が Public（大文字違い）なら検出する", () => {
      const violations = findPublishAccessViolations({
        publishConfig: { access: "Public" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("Public");
    });

    it("publishConfig.access が public なら検出しない", () => {
      expect(findPublishAccessViolations({ publishConfig: { access: "public" } })).toEqual([]);
    });
  });

  describe("findPrivateViolations（ADR 0066）", () => {
    it("private: true を検出する", () => {
      const violations = findPrivateViolations({ private: true });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("private");
    });

    it("private が無ければ検出しない", () => {
      expect(findPrivateViolations({ name: "@mnemora/core" })).toEqual([]);
    });

    it("private: false は検出しない（明示的に publish 可と書いた形）", () => {
      expect(findPrivateViolations({ private: false })).toEqual([]);
    });
  });

  describe("findOrphanedSourceMaps", () => {
    /** @type {string | undefined} */
    let fixtureDir;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("sources が tarball 内に実在すれば検出しない", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-map-ok-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(join(fixtureDir, "dist", "x.js"), "export {};\n");
      writeFileSync(
        join(fixtureDir, "dist", "x.d.ts.map"),
        JSON.stringify({ version: 3, sources: ["./x.js"] }),
      );

      expect(findOrphanedSourceMaps(fixtureDir)).toEqual([]);
    });

    it("sources が tarball 内に無ければ検出する（publish 前の現物で実際に起きていた形）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-map-orphan-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(
        join(fixtureDir, "dist", "index.d.ts.map"),
        JSON.stringify({ version: 3, sources: ["../src/index.ts"] }),
      );

      const orphans = findOrphanedSourceMaps(fixtureDir);
      expect(orphans).toHaveLength(1);
      expect(orphans[0]).toContain("index.d.ts.map");
      expect(orphans[0]).toContain("../src/index.ts");
    });
  });

  describe("findLicenseViolations（ADR 0061）", () => {
    /** @type {string | undefined} */
    let fixtureDir;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("license が MIT かつ LICENSE が実在すれば検出しない", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-ok-"));
      writeFileSync(join(fixtureDir, "LICENSE"), "MIT License\n");

      expect(findLicenseViolations({ license: "MIT" }, fixtureDir)).toEqual([]);
    });

    it("license が UNLICENSED なら検出する（LICENSE ファイルの有無に関わらず）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-unlicensed-"));
      writeFileSync(join(fixtureDir, "LICENSE"), "MIT License\n");

      const violations = findLicenseViolations({ license: "UNLICENSED" }, fixtureDir);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("MIT");
      expect(violations[0]).toContain("UNLICENSED");
    });

    /** `UNLICENSED` でないことだけを見ると `Apache-2.0` 等を通すので、`MIT` との等値で検査する（ADR 0061）。 */
    it("license が Apache-2.0 なら検出する（隣の値を通さない）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-apache-"));
      writeFileSync(join(fixtureDir, "LICENSE"), "Apache License\n");

      const violations = findLicenseViolations({ license: "Apache-2.0" }, fixtureDir);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("Apache-2.0");
    });

    it("LICENSE ファイルが無ければ検出する（license フィールドが MIT でも）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-missing-file-"));

      const violations = findLicenseViolations({ license: "MIT" }, fixtureDir);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("LICENSE ファイルが tarball に入っていません");
    });

    it("license も LICENSE も両方欠けていれば2件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-both-missing-"));

      const violations = findLicenseViolations({ license: "UNLICENSED" }, fixtureDir);
      expect(violations).toHaveLength(2);
    });
  });
});

/** 失敗側の実行時出力の歯は `check-publish-pack-failure-output.test.mjs` に置く。このファイルは `publish-targets.test.mjs` に走査されるので、publish 対象の形のリテラルを増やせない。 */
describe("scripts/check-publish-pack.mjs（動的・本物の pnpm pack を起動する）", () => {
  it("本物どおり起動すると EXIT=0 になる", () => {
    // 本物の `pnpm pack` を起動する。既定の 60 秒ではなく個別に 120 秒を置く。
    const result = spawnSyncWithDeadline(process.execPath, [gate], {
      cwd: repoRoot,
      encoding: "utf8",
      timeoutMs: 120_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, `期待した EXIT=0 にならなかった。出力:\n${output}`).toBe(0);
    expect(output).toContain("publish 梱包の門を通りました");
  }, 120_000);

  it("成功時の実行時出力に「⚠ この門が見ていない範囲」の断りが焼かれている（固定リストの取りこぼしを名乗る）", () => {
    // 本物の `pnpm pack` を起動する。既定の 60 秒ではなく個別に 120 秒を置く。
    const result = spawnSyncWithDeadline(process.execPath, [gate], {
      cwd: repoRoot,
      encoding: "utf8",
      timeoutMs: 120_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("⚠ この門が見ていない範囲:");
    expect(output).toContain("scripts/publish-targets.mjs の PUBLISH_TARGETS");
    expect(output).toContain("固定リスト");
    expect(output).toContain(`いま見たのは ${PUBLISH_TARGETS.length} パッケージ`);
    for (const target of PUBLISH_TARGETS) {
      expect(output).toContain(target.name);
    }
  }, 120_000);
});
