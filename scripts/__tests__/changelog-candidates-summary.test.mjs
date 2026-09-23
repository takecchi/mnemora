import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/changelog-candidates-summary.mjs`（CI の CLI 入口）の歯。
 *
 * `scripts/__tests__/changelog-candidates-summary-lib.test.mjs` は判定関数を合成データで
 * 直接検査するが、ここでは**本物のスクリプトを子プロセスとして起動し**、実際の `git` 履歴に
 * 対して `origin/main...HEAD` の差分を正しく読めるか・**終了コードが常に 0 であるか**
 * （歯4）を測る——`scripts/__tests__/check-pr-adr-reference.test.mjs` と同じ理由・同じ形
 * （合成 git 履歴に本物の `.mjs` を置いて動かす）。
 *
 * 🔴 **この歯がいちばん守りたいのは「門ではないこと」（歯4）である**——候補が1件でもあっても
 * `EXIT=0` のままであること。ここが赤くなったら、Issue #433 が2度却下した「載せ漏れを CI の
 * 歯にする」側へ実質的に戻ってしまっている。
 */

const realScriptsDir = fileURLToPath(new URL("..", import.meta.url));
const filesToCopy = [
  "changelog-candidates-summary.mjs",
  "changelog-candidates-summary-lib.mjs",
  // `changelog-candidates-summary-lib.mjs` は isPackageSrcPath() をここから import する
  // （「publish される中身」の述語を書き起こさず再利用する、という設計そのもの）。
  "release-candidates-lib.mjs",
];

/** @type {string | undefined} */
let repoDir;

afterEach(() => {
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  }
});

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * `origin/main`（released 節のみ・未リリース節を持たない — 【実測 2026-09-24】いまの
 * origin/main と同じ形）を用意し、そこから枝分かれしたブランチを作る土台。
 */
function initRepoWithReleasedOnlyChangelog() {
  repoDir = mkdtempSync(join(tmpdir(), "changelog-candidates-summary-"));
  const scriptsDir = join(repoDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const file of filesToCopy) {
    copyFileSync(join(realScriptsDir, file), join(scriptsDir, file));
  }
  mkdirSync(join(repoDir, "packages", "core", "src"), { recursive: true });

  git(["init", "-q"], repoDir);
  git(["config", "user.email", "test@example.com"], repoDir);
  git(["config", "user.name", "Test"], repoDir);
  git(["config", "commit.gpgsign", "false"], repoDir);
  git(["checkout", "-q", "-b", "main"], repoDir);

  writeFileSync(
    join(repoDir, "CHANGELOG.md"),
    ["# Changelog", "", "## [1.0.0] - 2026-09-23", "", "### Added", "- 初版"].join("\n"),
  );
  writeFileSync(
    join(repoDir, "packages", "core", "src", "recall.ts"),
    "export function recall() {}\n",
  );
  git(["add", "-A"], repoDir);
  git(["commit", "-q", "-m", "init"], repoDir);
  const base = git(["rev-parse", "HEAD"], repoDir).trim();
  git(["update-ref", "refs/remotes/origin/main", base], repoDir);

  git(["checkout", "-q", "-b", "feature"], repoDir);
  return repoDir;
}

function runCli(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts", "changelog-candidates-summary.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
}

describe("scripts/changelog-candidates-summary.mjs（本物の git 履歴に対して起動したときの配線）", () => {
  it("⭐ 歯1相当: packages/*/src を触るだけ（CHANGELOG.md 無変更）→ 候補が stdout に出る。かつ EXIT=0", () => {
    const dir = initRepoWithReleasedOnlyChangelog();
    writeFileSync(
      join(dir, "packages", "core", "src", "recall.ts"),
      "export function recall() { return 1; }\n",
    );
    git(["commit", "-q", "-a", "-m", "recall を直す"], dir);

    const result = runCli(dir);
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("packages/core/src/recall.ts");
    expect(result.stdout).toContain("判定ではない");
  });

  it("⭐ 歯2相当（陽性対照）: docs だけの変更 → 候補が出ない。かつ EXIT=0", () => {
    const dir = initRepoWithReleasedOnlyChangelog();
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "note.md"), "メモ\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "docs だけ"], dir);

    const result = runCli(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("🟢");
    expect(result.stdout).not.toContain("packages/core/src/recall.ts");
  });

  it("🔴 歯4: packages/*/src を触り候補が出る状況でも、終了コードは 0 のままである（これが崩れたら却下された『CI の歯』側へ戻る）", () => {
    const dir = initRepoWithReleasedOnlyChangelog();
    writeFileSync(
      join(dir, "packages", "core", "src", "recall.ts"),
      "export function recall() { return 2; }\n",
    );
    git(["commit", "-q", "-a", "-m", "recall をまた直す"], dir);

    const result = runCli(dir);
    expect(result.status).toBe(0);
    // 候補が実際に出ていることも併せて確認する（「候補が無いから0」ではないことを示す）
    expect(result.stdout).toContain("🔴 候補が");
  });

  it("git 呼び出しが失敗するとき（origin/main が存在しない）でも EXIT=0 で『判定していない』と出す", () => {
    repoDir = mkdtempSync(join(tmpdir(), "changelog-candidates-summary-broken-"));
    const scriptsDir = join(repoDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    for (const file of filesToCopy) {
      copyFileSync(join(realScriptsDir, file), join(scriptsDir, file));
    }
    git(["init", "-q"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    git(["config", "commit.gpgsign", "false"], repoDir);
    writeFileSync(join(repoDir, "CHANGELOG.md"), "# Changelog\n");
    git(["add", "-A"], repoDir);
    git(["commit", "-q", "-m", "init"], repoDir);
    // ⚠ わざと origin/main を作らない — git diff origin/main...HEAD は失敗するはず

    const result = runCli(repoDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("判定していない");
  });
});
