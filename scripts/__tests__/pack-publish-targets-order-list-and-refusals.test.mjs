import {
  cpSync,
  existsSync,
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
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * `pack-publish-targets.mjs` を、複製した一時ディレクトリで子プロセスとして起動する。
 * publish 対象の一覧（`publish-targets.mjs`）は fixture に差し替え、本物の `packages/` は pack しない。
 * fixture のパッケージは依存を持たないので、`pnpm pack` は registry へ取りに行く理由が無い。
 * そのうえで registry を届かない先へ向け、offline にし、store を空の一時ディレクトリにして、
 * store に何も書かれないことまで確かめる（取りに行こうとしたら赤くなる）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageManager = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
).packageManager;

/** 依存の向きの順。名前の順（alpha → zeta）とは逆にしてあり、並べ替えると崩れる。 */
const TARGETS = [
  { name: "@fx/zeta", dir: "packages/zeta" },
  { name: "@fx/alpha", dir: "packages/alpha" },
];

/** @type {string | undefined} */
let sandbox;

afterEach(() => {
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

/**
 * @param {{ manifests?: Record<string, object>, targets?: { name: string, dir: string }[] }} [options]
 */
function makeSandbox({ manifests = {}, targets = TARGETS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pack-publish-targets-"));
  mkdirSync(join(dir, "scripts"));
  cpSync(
    join(repoRoot, "scripts", "pack-publish-targets.mjs"),
    join(dir, "scripts", "pack-publish-targets.mjs"),
  );
  writeFileSync(
    join(dir, "scripts", "publish-targets.mjs"),
    `export const PUBLISH_TARGETS = ${JSON.stringify(targets)};\n`,
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, packageManager }));
  for (const target of TARGETS) {
    const pkgDir = join(dir, target.dir);
    mkdirSync(pkgDir, { recursive: true });
    const manifest = manifests[target.name] ?? {
      name: target.name,
      version: "1.2.3",
      files: ["index.js"],
    };
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(pkgDir, "index.js"), "export {};\n");
  }
  return dir;
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function run(dir, args) {
  const store = join(dir, "store");
  mkdirSync(store);
  const result = spawnSyncWithDeadline(
    process.execPath,
    [join(dir, "scripts", "pack-publish-targets.mjs"), ...args],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_registry: "http://127.0.0.1:9/",
        npm_config_offline: "true",
        npm_config_store_dir: store,
        COREPACK_ENABLE_NETWORK: "0",
      },
    },
  );
  expect(readdirSync(store), "pnpm pack が store へ何かを取りに行った").toEqual([]);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** publish.yml の npm publish の段と同じ読み方（`while IFS= read -r`）で、一覧から読める行を数える。 */
function readLikePublishYml(listPath) {
  const result = spawnSyncWithDeadline(
    "bash",
    [
      "-c",
      'while IFS= read -r tarball; do printf "%s\\n" "${tarball}"; done < "$1"',
      "_",
      listPath,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter((line) => line !== "");
}

describe("pack-publish-targets.mjs —— 一覧は publish 対象の順に、全部が読める形で書く", () => {
  it("publish-order.txt を publish 対象の順（依存の向き）に並べ、publish.yml の読み方で全件読める", () => {
    sandbox = makeSandbox();
    const dest = join(sandbox, "tarballs");

    const r = run(sandbox, [dest]);

    expect(r.status, `exit 0 を期待した。stderr:\n${r.stderr}`).toBe(0);
    const listPath = join(dest, "publish-order.txt");
    const lines = readLikePublishYml(listPath);
    expect(lines).toHaveLength(TARGETS.length);
    expect(lines.map((line) => line.split("/").at(-1))).toEqual([
      "fx-zeta-1.2.3.tgz",
      "fx-alpha-1.2.3.tgz",
    ]);
    for (const line of lines) expect(existsSync(line), line).toBe(true);
  });

  it("--expect-version を省いても走る（版の確かめを付けずに pack だけを使う呼び手がある）", () => {
    sandbox = makeSandbox();
    expect(run(sandbox, [join(sandbox, "tarballs")]).status).toBe(0);
  });

  it("publish.yml の形（出力先 → --expect-version <版>）で、一覧を出力先に書く", () => {
    sandbox = makeSandbox();
    const dest = join(sandbox, "tarballs");

    const r = run(sandbox, [dest, "--expect-version", "1.2.3"]);

    expect(r.status, `exit 0 を期待した。stderr:\n${r.stderr}`).toBe(0);
    expect(existsSync(join(dest, "publish-order.txt"))).toBe(true);
  });
});

describe("pack-publish-targets.mjs —— おかしな入力では一覧を書かずに exit 1 で止める", () => {
  it("--expect-version と package.json の版が食い違う", () => {
    sandbox = makeSandbox();
    const dest = join(sandbox, "tarballs");

    const r = run(sandbox, [dest, "--expect-version", "9.9.9"]);

    expect(r.status).toBe(1);
    expect(existsSync(join(dest, "publish-order.txt"))).toBe(false);
  });

  it("--expect-version に版が付いていない", () => {
    sandbox = makeSandbox();
    expect(run(sandbox, [join(sandbox, "tarballs"), "--expect-version"]).status).toBe(1);
  });

  it("publish 対象の name と package.json の name が食い違う", () => {
    sandbox = makeSandbox({
      targets: [{ name: "@fx/other", dir: "packages/zeta" }, TARGETS[1]],
    });
    const dest = join(sandbox, "tarballs");

    const r = run(sandbox, [dest]);

    expect(r.status).toBe(1);
    expect(existsSync(join(dest, "publish-order.txt"))).toBe(false);
  });

  it("pnpm pack が tarball を作ったあとで非0で終わる", () => {
    // postpack は tarball を書いたあとに走る。tarball が1つ在っても、pack の失敗を通さないこと。
    sandbox = makeSandbox({
      manifests: {
        "@fx/alpha": {
          name: "@fx/alpha",
          version: "1.2.3",
          files: ["index.js"],
          scripts: { postpack: "exit 7" },
        },
      },
    });
    const dest = join(sandbox, "tarballs");

    const r = run(sandbox, [dest]);

    expect(r.status).toBe(1);
    expect(existsSync(join(dest, "publish-order.txt"))).toBe(false);
  });

  it("pack 先に前の tarball が残っていて、tarball が1つに決まらない", () => {
    sandbox = makeSandbox();
    const dest = join(sandbox, "tarballs");
    mkdirSync(join(dest, "fx-alpha"), { recursive: true });
    writeFileSync(join(dest, "fx-alpha", "fx-alpha-0.0.1.tgz"), "");

    const r = run(sandbox, [dest]);

    expect(r.status).toBe(1);
    expect(existsSync(join(dest, "publish-order.txt"))).toBe(false);
  });
});
