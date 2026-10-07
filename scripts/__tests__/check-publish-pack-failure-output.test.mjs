import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/** `check-publish-pack.test.mjs` とは別のファイルにする。`publish-targets.test.mjs` がそちらのソースを正規表現で走査して直書きの `{ name, dir }` の件数を数えるので、合成フィクスチャを同じファイルへ置くと7件を数えて落ちる。 */

describe("scripts/check-publish-pack.mjs（合成 publish-targets.mjs で失敗分岐を実行時に測る）", () => {
  /** @type {string | undefined} */
  let workDir;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  function buildBrokenTargetFixture() {
    workDir = mkdtempSync(join(tmpdir(), "check-publish-pack-broken-target-"));
    const scriptsDir = join(workDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("../check-publish-pack.mjs", import.meta.url)),
      join(scriptsDir, "check-publish-pack.mjs"),
    );
    copyFileSync(
      fileURLToPath(new URL("../publish-pack-checks.mjs", import.meta.url)),
      join(scriptsDir, "publish-pack-checks.mjs"),
    );
    writeFileSync(
      join(scriptsDir, "publish-targets.mjs"),
      [
        "// 合成フィクスチャ: 実在しないディレクトリを指す唯一の publish 対象。",
        "export const PUBLISH_TARGETS = [",
        '  { name: "@mnemora/does-not-exist", dir: "packages/does-not-exist" },',
        "];",
        "",
      ].join("\n"),
    );
    return workDir;
  }

  it("EXIT=1 になり、失敗時の実行時出力にも同じ断りが焼かれている", () => {
    const dir = buildBrokenTargetFixture();
    const result = spawnSyncWithDeadline(
      process.execPath,
      [join(dir, "scripts", "check-publish-pack.mjs")],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, `EXIT=1 を期待した。出力:\n${output}`).toBe(1);
    expect(output).toContain("✗ 違反が");
    expect(output).toContain("⚠ この門が見ていない範囲:");
    expect(output).toContain("scripts/publish-targets.mjs の PUBLISH_TARGETS");
    expect(output).toContain("固定リスト");
    expect(output).toContain("いま見たのは 1 パッケージ");
    expect(output).toContain("@mnemora/does-not-exist");
  });
});
