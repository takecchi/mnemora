import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/** 実物の dist・snapshot には触れない。CI では Test 段が Build 段より前にあり、dist がまだ無いことがある。 */

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

/** @type {string | undefined} */
let packagesRoot;
/** @type {string | undefined} */
let snapshotDir;

afterEach(() => {
  if (packagesRoot) {
    rmSync(packagesRoot, { recursive: true, force: true });
    packagesRoot = undefined;
  }
  if (snapshotDir) {
    rmSync(snapshotDir, { recursive: true, force: true });
    snapshotDir = undefined;
  }
});

function newFixtureRoots() {
  const base = mkdtempSync(join(tmpdir(), "api-check-cli-"));
  packagesRoot = join(base, "packages");
  snapshotDir = join(base, "snapshots");
  for (const name of PACKAGE_DIRS) {
    const dir = join(packagesRoot, name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: `@mnemora/${name}`,
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "dist/index.d.ts"), "export declare const ok: true;\n", "utf8");
  }
  return { packagesRoot, snapshotDir };
}

function writeIndexDts(name, contents) {
  writeFileSync(join(packagesRoot, name, "dist/index.d.ts"), contents, "utf8");
}

function runGate(extraArgs = []) {
  const result = spawnSyncWithDeadline(process.execPath, [gate, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MNEMORA_API_CHECK_PACKAGES_ROOT: packagesRoot,
      MNEMORA_API_CHECK_SNAPSHOT_DIR: snapshotDir,
    },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("scripts/check-public-api-surface.mjs（公開 API 表面の門）", () => {
  it("snapshot が無ければ、--write を促した上で非0", () => {
    newFixtureRoots();
    const { status, output } = runGate();
    expect(status).not.toBe(0);
    expect(output).toContain("snapshot が存在しません");
    expect(output).toContain("--write");
  });

  it("--write で snapshot を書き、以後は差分なしで緑になる", () => {
    newFixtureRoots();
    const write = runGate(["--write"]);
    expect(write.status, `stderr含む出力:\n${write.output}`).toBe(0);
    for (const name of PACKAGE_DIRS) {
      const snapshot = readFileSync(join(snapshotDir, `${name}.d.ts`), "utf8");
      expect(snapshot).toContain("export declare const ok: true;");
    }

    const check = runGate();
    expect(check.status, `stderr含む出力:\n${check.output}`).toBe(0);
    expect(check.output).toContain("公開 API 表面の門を通りました");
  });

  it("🔴 必須メソッド追加（ADR 0161 型の変異）を与えると赤くなり、diff と次の手順を出す", () => {
    newFixtureRoots();
    expect(runGate(["--write"]).status).toBe(0);

    writeIndexDts(
      "core",
      [
        "export interface Runtime {",
        "  observe(): void;",
        "  getRecall(): Promise<number | null>;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(packagesRoot, "core", "dist/index.d.ts"),
      "export declare const ok: true;\n",
      "utf8",
    );
    writeIndexDts(
      "core",
      [
        "export declare const ok: true;",
        "export interface Runtime {",
        "  getRecall(): Promise<number | null>;",
        "}",
        "",
      ].join("\n"),
    );

    const { status, output } = runGate();
    expect(status).not.toBe(0);
    expect(output).toContain("[@mnemora/core]");
    expect(output).toContain("getRecall");
    expect(output).toContain("次にすること");
    expect(output).toContain("ADR 0178");
    expect(output).toContain("--write");
    expect(output).toContain("[@mnemora/testkit] 差分なし");
  });

  it("変異後に --write すれば再び緑に戻る（壊れた→直した の両方向を確かめる）", () => {
    newFixtureRoots();
    expect(runGate(["--write"]).status).toBe(0);

    writeIndexDts(
      "core",
      "export declare const ok: true;\nexport declare const changed: number;\n",
    );
    expect(runGate().status).not.toBe(0);

    expect(runGate(["--write"]).status).toBe(0);
    expect(runGate().status).toBe(0);
  });

  it("差分が無いパッケージは --write でも中身が変わらない（無関係な変異は無い）", () => {
    newFixtureRoots();
    runGate(["--write"]);
    const before = readFileSync(join(snapshotDir, "testkit.d.ts"), "utf8");

    writeIndexDts(
      "core",
      "export declare const ok: true;\nexport declare const changed: number;\n",
    );
    runGate(["--write"]);
    const after = readFileSync(join(snapshotDir, "testkit.d.ts"), "utf8");
    expect(after).toBe(before);
  });
});
