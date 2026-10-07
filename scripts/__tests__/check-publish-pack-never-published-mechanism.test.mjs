import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

// NEVER_PUBLISHED_TARGETS は定数で、門の本体に差し込み口が無い。本物の門を合成した repo へ写して、一覧の中身だけを書き換えて走らせる。
// 合成の対象は pnpm pack が実際に動く最小のパッケージにする（pack を差し替えると、version の検査へ届く前の経路を見てしまう）。

const EMPTY_LIST_SOURCE = "export const NEVER_PUBLISHED_TARGETS = new Set([]);";

/** @param {string} version */
function manifestOf(name, version) {
  return {
    name,
    version,
    type: "module",
    license: "MIT",
    main: "./dist/index.js",
    exports: { ".": { default: "./dist/index.js" } },
    publishConfig: { access: "public" },
  };
}

describe("check-publish-pack.mjs は NEVER_PUBLISHED_TARGETS の名前だけ version 検査から外す", () => {
  /** @type {string | undefined} */
  let workDir;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  /**
   * @param {{ neverPublished: string[]; packages: Record<string, string> }} spec 名前 → version
   */
  function run(spec) {
    workDir = mkdtempSync(join(tmpdir(), "check-publish-pack-never-published-"));
    const scriptsDir = join(workDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("../check-publish-pack.mjs", import.meta.url)),
      join(scriptsDir, "check-publish-pack.mjs"),
    );
    const checksSource = readFileSync(
      fileURLToPath(new URL("../publish-pack-checks.mjs", import.meta.url)),
      "utf8",
    );
    expect(checksSource, "NEVER_PUBLISHED_TARGETS の宣言が読み取れなかった").toContain(
      EMPTY_LIST_SOURCE,
    );
    writeFileSync(
      join(scriptsDir, "publish-pack-checks.mjs"),
      checksSource.replace(
        EMPTY_LIST_SOURCE,
        `export const NEVER_PUBLISHED_TARGETS = new Set(${JSON.stringify(spec.neverPublished)});`,
      ),
    );
    const targets = Object.keys(spec.packages).map((name) => ({
      name,
      dir: `packages/${name.split("/")[1]}`,
    }));
    writeFileSync(
      join(scriptsDir, "publish-targets.mjs"),
      `export const PUBLISH_TARGETS = ${JSON.stringify(targets)};\n`,
    );
    for (const t of targets) {
      const pkgDir = join(workDir, t.dir);
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify(manifestOf(t.name, spec.packages[t.name])),
      );
      writeFileSync(join(pkgDir, "README.md"), "# synthetic\n");
      writeFileSync(join(pkgDir, "LICENSE"), "MIT\n");
      writeFileSync(join(pkgDir, "dist", "index.js"), "export const x = 1;\n");
    }
    const r = spawnSyncWithDeadline(
      process.execPath,
      [join(scriptsDir, "check-publish-pack.mjs")],
      { cwd: workDir, encoding: "utf8", timeoutMs: 90_000 },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  const released = { "@x/released-a": "0.1.0", "@x/released-b": "0.1.0" };

  it("一覧に載った名前の version が 0.0.0 のままでも、ほかが揃っていれば通る", () => {
    const r = run({ neverPublished: ["@x/fresh"], packages: { ...released, "@x/fresh": "0.0.0" } });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("[@x/fresh] version 検査を対象外にしました");
  });

  it("対照: 一覧が空なら、同じ構成で 0.0.0 の名前が version の違反になる", () => {
    const r = run({ neverPublished: [], packages: { ...released, "@x/fresh": "0.0.0" } });
    expect(r.status).toBe(1);
    expect(r.out).toContain("[@x/fresh] version が未設定か 0.0.0 のままです");
  });

  it("一覧に載った名前を外しても、残りの版がずれていれば版の不揃いで落ちる", () => {
    const r = run({
      neverPublished: ["@x/fresh"],
      packages: { "@x/released-a": "0.1.0", "@x/released-b": "0.2.0", "@x/fresh": "0.0.0" },
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("version が publish 対象で揃っていません");
    expect(r.out).not.toContain("[@x/fresh] version が未設定");
  });

  it("一覧に載っていない名前の 0.0.0 は、一覧に載った別の名前があっても違反になる", () => {
    const r = run({
      neverPublished: ["@x/fresh"],
      packages: { ...released, "@x/fresh": "0.0.0", "@x/other": "0.0.0" },
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("[@x/other] version が未設定か 0.0.0 のままです");
    expect(r.out).not.toContain("[@x/fresh] version が未設定");
  });
});
