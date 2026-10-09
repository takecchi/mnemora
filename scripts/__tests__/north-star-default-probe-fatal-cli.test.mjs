import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const SCRIPT_FILES = [
  "north-star-default-probe.mjs",
  "north-star-default-probe-lib.mjs",
  "north-star-probe-runtime.mjs",
];

let workdir;

afterEach(() => {
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

/**
 * repo の外へ写して動かす。`@mnemora/*` が解決できない場所なので、ワークスペースが build 済みかどうかに
 * かかわらず、トップレベルの import が必ず失敗する。
 */
describe("north-star-default-probe.mjs: トップレベルの失敗も握って、exit 0 で一覧を出す", () => {
  it("@mnemora/* を import できなくても exit 0 で、トップレベルの失敗を Markdown に出す", () => {
    workdir = mkdtempSync(join(tmpdir(), "north-star-default-probe-fatal-"));
    const scriptsDir = join(workdir, "scripts");
    mkdirSync(scriptsDir);
    for (const name of SCRIPT_FILES) {
      copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(scriptsDir, name));
    }
    const result = spawnSyncWithDeadline(
      "node",
      [join(scriptsDir, "north-star-default-probe.mjs")],
      { cwd: workdir, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("印字に失敗した（トップレベル）");
    expect(result.stdout).toContain("@mnemora/");
  });
});
