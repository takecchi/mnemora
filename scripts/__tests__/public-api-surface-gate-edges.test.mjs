import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublicApiSnapshotText,
  collectReachableDeclarationFiles,
  entryTypesFilesFromExports,
} from "../public-api-surface-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * 公開 API 表面の門（`check-public-api-surface.mjs`・`public-api-surface-lib.mjs`。Issue #342・ADR 0178）の
 * 歯の足し（Issue #1815、09/16 マージ分の #380・#423 の確かめ直し）。
 *
 * 既存の `check-public-api-surface.test.mjs`・`public-api-surface-lib.test.mjs` が見ていなかった形だけを足す
 * （変異が素通りした）: 差分が出たときの手順の「先に build する」（#423 が足した約束）・同じ長さの書き換え・
 * dist が無いときの失敗・親ディレクトリへの相対 import・`types` を持たない `exports` の項・出力の連結の形。
 * 実装は変えない。**これはクローン（miku）の判断で足した歯で、オーナーの判断ではない**（ADR 0220）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../check-public-api-surface.mjs", import.meta.url));
const PACKAGE_DIRS = [
  "core",
  "testkit",
  "openai",
  "postgres",
  "anthropic",
  "local-embedding",
  "bullmq",
];

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot() {
  const r = mkdtempSync(join(tmpdir(), "api-gate-edges-"));
  roots.push(r);
  return r;
}

function put(dir, rel, text) {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, "utf8");
  return full;
}

function fixture() {
  const base = newRoot();
  const packagesRoot = join(base, "packages");
  const snapshotDir = join(base, "snapshots");
  for (const name of PACKAGE_DIRS) {
    put(
      join(packagesRoot, name),
      "package.json",
      JSON.stringify({
        name: `@mnemora/${name}`,
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      }),
    );
    put(join(packagesRoot, name), "dist/index.d.ts", "export declare const a: number;\n");
  }
  const run = (args = []) => {
    const r = spawnSyncWithDeadline(process.execPath, [gate, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MNEMORA_API_CHECK_PACKAGES_ROOT: packagesRoot,
        MNEMORA_API_CHECK_SNAPSHOT_DIR: snapshotDir,
      },
    });
    return { ...r, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  return { packagesRoot, snapshotDir, run };
}

describe("公開 API 表面の門（CLI）", () => {
  it("同じ長さの書き換え（`number` → `string`）も、差分として赤くなる", () => {
    const f = fixture();
    expect(f.run(["--write"]).status).toBe(0);
    put(join(f.packagesRoot, "core"), "dist/index.d.ts", "export declare const a: string;\n");
    const r = f.run();
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("[@mnemora/core] 公開型シグネチャが snapshot と一致しません");
  });

  it("差分が出たときの手順は、--write の前に `pnpm run build` で dist を作り直すことを言う（#423）", () => {
    const f = fixture();
    expect(f.run(["--write"]).status).toBe(0);
    put(join(f.packagesRoot, "core"), "dist/index.d.ts", "export declare const a: string;\n");
    const { output } = f.run();
    const build = output.indexOf("pnpm run build");
    const write = output.lastIndexOf("--write");
    expect(build).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(build);
    // 古い dist のまま --write すると、他人が入れた変更を snapshot から消してしまう、という理由も添える
    expect(output).toContain("snapshot から消してしまう");
  });

  it("dist が無いパッケージがあれば、snapshot があっても非0で、build を促す（黙って通さない）", () => {
    const f = fixture();
    expect(f.run(["--write"]).status).toBe(0);
    rmSync(join(f.packagesRoot, "openai", "dist"), { recursive: true, force: true });
    const r = f.run();
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("[@mnemora/openai]");
    expect(r.output).toContain("pnpm run build");
  });

  it("--write は、差分の無い snapshot も上書きして書く（中身は変わらない）", () => {
    const f = fixture();
    expect(f.run(["--write"]).status).toBe(0);
    const again = f.run(["--write"]);
    expect(again.status).toBe(0);
    expect(again.output).toContain("snapshot を書きました");
  });
});

describe("public-api-surface-lib の拾い方", () => {
  it("親ディレクトリへの相対 import（`../x.js`）も辿る", () => {
    const dir = newRoot();
    const entry = put(dir, "dist/sub/index.d.ts", 'export * from "../shared.js";\n');
    const shared = put(dir, "dist/shared.d.ts", "export declare const s: number;\n");
    expect(collectReachableDeclarationFiles([entry])).toEqual([shared, entry].sort());
  });

  it("`types` を持たない `exports` の項は読み飛ばし、持つ項は拾う", () => {
    const dir = newRoot();
    const entries = entryTypesFilesFromExports(
      {
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./runtime": { default: "./dist/runtime.js" },
        },
      },
      dir,
    );
    expect(entries.map((e) => e.subpath)).toEqual(["."]);
  });

  it("連結の形: 各ファイルは見出し・本文・改行で、ファイルの間は空行1つで区切る", () => {
    const dir = newRoot();
    put(dir, "dist/index.d.ts", 'export * from "./a.js";\n');
    put(dir, "dist/a.d.ts", "export declare const a: string;\n");
    const text = buildPublicApiSnapshotText(dir, {
      exports: { ".": { types: "./dist/index.d.ts" } },
    });
    expect(text).toBe(
      [
        "// ===== dist/a.d.ts =====",
        "export declare const a: string;",
        "",
        "// ===== dist/index.d.ts =====",
        'export * from "./a.js";',
        "",
      ].join("\n"),
    );
  });
});
