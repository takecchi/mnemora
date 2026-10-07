import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSmokeCjs, buildSmokeMjs } from "../check-consumer-install-lib.mjs";

// smoke は生成した文字列を子プロセスで実行して見る。文字列の照合では、検査の条件を無効にした実装も通ってしまう。

/**
 * @param {Record<string, { exports: unknown; files: Record<string, string> }>} packages
 *   指定子（`@a/b` の形）→ node_modules の中に置くパッケージ
 * @param {{ kind: "mjs" | "cjs"; entries: string[]; valueNames: Record<string, string[]>; outsideNodeModules?: string[] }} opts
 */
function runSmoke(packages, opts) {
  const dir = mkdtempSync(join(tmpdir(), "mnemora-smoke-cjs-behavior-"));
  try {
    for (const [spec, pkg] of Object.entries(packages)) {
      const [scope, name] = spec.split("/");
      const inNodeModules = join(dir, "node_modules", scope, name);
      const real = opts.outsideNodeModules?.includes(spec)
        ? join(dir, "elsewhere", scope, name)
        : inNodeModules;
      mkdirSync(real, { recursive: true });
      writeFileSync(
        join(real, "package.json"),
        JSON.stringify({ name: spec, version: "0.0.0", exports: pkg.exports }),
      );
      for (const [file, body] of Object.entries(pkg.files)) writeFileSync(join(real, file), body);
      if (real !== inNodeModules) {
        mkdirSync(join(dir, "node_modules", scope), { recursive: true });
        symlinkSync(real, inNodeModules, "dir");
      }
    }
    const file = opts.kind === "mjs" ? "smoke.mjs" : "smoke.cjs";
    const build = opts.kind === "mjs" ? buildSmokeMjs : buildSmokeCjs;
    writeFileSync(join(dir, file), build(opts.entries, opts.valueNames));
    const r = spawnSync(process.execPath, [file], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const okPackage = (names) => ({
  exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
  files: {
    "index.mjs": names.map((n) => `export const ${n} = 1;`).join("\n"),
    "index.cjs": names.map((n) => `exports.${n} = 1;`).join("\n"),
  },
});

const throwingPackage = {
  exports: { ".": { require: "./index.cjs" } },
  files: { "index.cjs": 'throw new Error("boom-at-require");\n' },
};

const topLevelAwaitPackage = {
  exports: "./index.mjs",
  files: { "index.mjs": "await Promise.resolve();\nexport const foo = 1;\n" },
};

describe("smoke.cjs は require に失敗した入口を赤にする", () => {
  it("require が例外を投げる入口は、指定子と例外の message を出して exit 1", () => {
    const r = runSmoke(
      { "@a/b": throwingPackage },
      { kind: "cjs", entries: ["@a/b"], valueNames: { "@a/b": ["foo"] } },
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("@a/b");
    expect(r.out).toContain("boom-at-require");
  });

  it("top-level await を持つ ESM の入口は、ESM の smoke は緑のまま、CommonJS の smoke だけが ERR_REQUIRE_ASYNC_MODULE で赤", () => {
    const packages = { "@a/b": topLevelAwaitPackage };
    const base = { entries: ["@a/b"], valueNames: { "@a/b": ["foo"] } };
    expect(runSmoke(packages, { kind: "mjs", ...base }).status).toBe(0);
    const cjs = runSmoke(packages, { kind: "cjs", ...base });
    expect(cjs.status).toBe(1);
    expect(cjs.out).toContain("ERR_REQUIRE_ASYNC_MODULE");
  });
});

describe("smoke.cjs は全入口を1つずつ見る", () => {
  const packages = (a, b) => ({ "@a/first": a, "@a/second": b });
  const opts = {
    kind: "cjs",
    entries: ["@a/first", "@a/second"],
    valueNames: { "@a/first": ["foo"], "@a/second": ["foo"] },
  };

  it("両方読めるなら緑", () => {
    expect(runSmoke(packages(okPackage(["foo"]), okPackage(["foo"])), opts).status).toBe(0);
  });

  it("2つ目だけ読めない入口は赤で、その指定子を名指しする", () => {
    const r = runSmoke(packages(okPackage(["foo"]), throwingPackage), opts);
    expect(r.status).toBe(1);
    expect(r.out).toContain("@a/second");
    expect(r.out).not.toContain("@a/first:");
  });

  it("1つ目だけ読めない入口も赤で、その指定子を名指しする", () => {
    const r = runSmoke(packages(throwingPackage, okPackage(["foo"])), opts);
    expect(r.status).toBe(1);
    expect(r.out).toContain("@a/first");
    expect(r.out).not.toContain("@a/second:");
  });
});

describe("smoke.cjs は解決先が install 先の node_modules の外へ出た入口を赤にする", () => {
  const opts = { kind: "cjs", entries: ["@a/b"], valueNames: { "@a/b": ["foo"] } };

  it("node_modules の外の実体へ解決する入口は、読めても赤で、外へ解決したと出す", () => {
    const r = runSmoke({ "@a/b": okPackage(["foo"]) }, { ...opts, outsideNodeModules: ["@a/b"] });
    expect(r.status).toBe(1);
    expect(r.out).toContain("node_modules の外へ解決した");
  });

  it("対照: 実体が node_modules の中にあれば緑", () => {
    expect(runSmoke({ "@a/b": okPackage(["foo"]) }, opts).status).toBe(0);
  });
});

describe("smoke.cjs は export が1つだけの入口を落とさない", () => {
  it("名前が1つだけの入口で、その名前が揃っていれば緑", () => {
    const r = runSmoke(
      {
        "@a/b": {
          exports: { ".": { require: "./index.cjs" } },
          files: { "index.cjs": "exports.only = 1;\n" },
        },
      },
      { kind: "cjs", entries: ["@a/b"], valueNames: { "@a/b": ["only"] } },
    );
    expect(r.status).toBe(0);
  });
});

describe("check-consumer-install.mjs は CommonJS の段を失敗に数える", () => {
  // この道具は registry へ繋がり既定の CI で走らせられない。配線の欠けは走らせずに文字列で見るしかない。
  const source = readFileSync(
    fileURLToPath(new URL("../check-consumer-install.mjs", import.meta.url)),
    "utf8",
  );

  it("smoke.cjs を buildSmokeCjs で書き出す", () => {
    expect(source).toMatch(
      /writeFileSync\(\s*join\(consumerDir, "smoke\.cjs"\),\s*buildSmokeCjs\(/,
    );
  });

  it("smoke.cjs を node で実行する段の失敗が、全体の失敗（failed）になる", () => {
    expect(source).toMatch(
      /const cjs = step\([^;]*?run\(process\.execPath, \["smoke\.cjs"\], consumerDir\)[^;]*?\);\s*if \(!cjs\.ok\) failed = true;/s,
    );
  });
});
