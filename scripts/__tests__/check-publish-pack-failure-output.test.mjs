import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-publish-pack.mjs` の**失敗（EXIT=1）側の実行時出力**の歯
 * （ADR 0255 が反例として名指しし、ADR 0259 が実行時出力へ焼いた断り）。
 *
 * ## ⭐ なぜ `check-publish-pack.test.mjs` と別のファイルなのか
 *
 * 🔴 **`scripts/__tests__/publish-targets.test.mjs` が `check-publish-pack.test.mjs` の
 * ソースを正規表現で走査し、そこに直書きされた `{ name: "@mnemora/…", dir: "packages/…" }`
 * の件数が `PUBLISH_TARGETS` と一致することを測っている**（写しがずれたまま気づかないのを
 * 防ぐ歯）。⟹ 下の合成フィクスチャ（実在しない publish 対象を1件だけ持つ
 * `publish-targets.mjs` を組み立てる）を同じファイルへ置くと、**その走査が7件を数えて落ちる。**
 * ⛔ 走査される側の書き方を変えて避けるのではなく（それは既存の歯の目をくぐる形になる）、
 * **走査の対象ではないファイルへ置く**。⚠ 【実測】この衝突は手元の名指し実行では出ず、
 * CI が最初に見つけた（Issue #580 / PR #582）。
 */

/**
 * ⚠ この門が見ていない範囲——失敗（EXIT=1）側の実行時出力を測る歯。
 *
 * `scripts/__tests__/check-pr-adr-reference.test.mjs` と同じ形（本物の `.mjs` を
 * 一時ディレクトリへコピーし、合成環境で動かす）を踏襲する。`publish-targets.mjs` を
 * 「存在しないディレクトリを指す1パッケージだけの合成版」へ差し替えると、
 * `pnpm pack` の spawn 自体が ENOENT で失敗し（`cwd` が存在しないため）、
 * `packOne()` が投げた例外を `violations` へ積んで exit 1 になる——本物の
 * `pnpm pack` プロセスは1つも起動しないので速い（手元で実測 約40ms）。
 */
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
    const result = spawnSync(process.execPath, [join(dir, "scripts", "check-publish-pack.mjs")], {
      cwd: dir,
      encoding: "utf8",
    });
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
