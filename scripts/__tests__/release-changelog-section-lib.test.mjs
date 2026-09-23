import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeChangelogFollowUp,
  findChangelogSection,
  versionFromTagName,
} from "../release-changelog-section-lib.mjs";

/**
 * リリース後の追随通知（ADR 0251）の歯。
 *
 * ⚠ このファイルは `gh` を1度も呼ばない。`CHANGELOG.md` は合成した入力で表現する
 * ——`release-candidates-lib.test.mjs` が commit を合成するのと同じ役割分担。
 *
 * 🔴 **この歯がいちばん守りたいのは「門ではないこと」である**
 * ——`describe("⛔ 門ではない …")` の2本。ここが赤くなったら、
 * **採らなかった案（required で強制する形）へ移ってしまっている。**
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(REPO_ROOT, "scripts", "check-release-changelog-section.mjs");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "release-followup-notice.yml");

/** 終了コードを取りたいので、失敗しても投げない形で回す。 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", GITHUB_REF_NAME: "" },
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? -1, stdout: String(err.stdout ?? "") };
  }
}

describe("versionFromTagName", () => {
  it("先頭の `v` を1つだけ落とす", () => {
    expect(versionFromTagName("v1.2.3")).toBe("1.2.3");
    expect(versionFromTagName("1.2.3")).toBe("1.2.3");
    expect(versionFromTagName(" v1.2.3 ")).toBe("1.2.3");
  });

  it("空・未定義でも例外を投げない（この道具は何も止めない側である）", () => {
    expect(versionFromTagName("")).toBe("");
    expect(versionFromTagName(undefined)).toBe("");
  });
});

describe("findChangelogSection", () => {
  const changelog = ["# Changelog", "", "## [1.2.3] - 2026-09-19", "", "### Breaking", ""].join(
    "\n",
  );

  it("`## [版]` の見出しを行番号つきで見つける", () => {
    const hit = findChangelogSection(changelog, "1.2.3");
    expect(hit.found).toBe(true);
    expect(hit.lineNumber).toBe(3);
  });

  it("🔴 `1.2.3` が `1.2.30` の節に当たらない（無い節を「在る」と報告しないため）", () => {
    expect(findChangelogSection("## [1.2.30] - 2026-09-19", "1.2.3").found).toBe(false);
  });

  it("見出しの深さが違うものには当たらない", () => {
    expect(findChangelogSection("### [1.2.3]", "1.2.3").found).toBe(false);
  });

  it("節が無ければ found=false（例外にしない）", () => {
    expect(findChangelogSection(changelog, "9.9.9").found).toBe(false);
  });
});

describe("describeChangelogFollowUp", () => {
  it("在るときは ⭕ を出し、『中身は見ていない』を必ず添える", () => {
    const verdict = describeChangelogFollowUp({
      tagName: "v1.2.3",
      changelogText: "## [1.2.3] - 2026-09-19",
    });
    expect(verdict.found).toBe(true);
    expect(verdict.message).toContain("中身");
  });

  it("無いときは 🔴 を出し、⛔ 門ではないことを添える", () => {
    const verdict = describeChangelogFollowUp({ tagName: "v9.9.9", changelogText: "# Changelog" });
    expect(verdict.found).toBe(false);
    expect(verdict.message).toContain("門ではない");
  });

  it("tag 名が空なら『判定していない』と名乗る（黙って緑にしない）", () => {
    const verdict = describeChangelogFollowUp({ tagName: "", changelogText: "# Changelog" });
    expect(verdict.message).toContain("判定していない");
  });
});

describe("⛔ 門ではないこと —— ここが赤くなったら、却下した案へ移っている（ADR 0251）", () => {
  it("節が無い tag を渡しても終了コードは 0 である", () => {
    const result = runCli(["v9.9.9"]);
    expect(result.status, `stdout: ${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("門ではない");
  });

  it("tag を渡さなくても終了コードは 0 である", () => {
    expect(runCli([]).status).toBe(0);
  });
});

describe(".github/workflows/release-followup-notice.yml の配線", () => {
  const workflow = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, "utf8") : "";

  it("この歯はワークフローを実際に読んでいる（読めなければ以下は何も測っていない）", () => {
    expect(workflow, `${WORKFLOW_PATH} が読めなかった`).not.toBe("");
  });

  it("Release の publish を引き金にしている", () => {
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[\s*published\s*\]/);
  });

  it("⛔ 失敗を握り潰す指定（continue-on-error）に頼っていない —— 終了コードが常に 0 だから要らない", () => {
    expect(workflow).not.toMatch(/continue-on-error/);
  });

  it("🔴 呼んでいる node script が実在する（⛔ 名前ではなく、形で選んで実在を見る）", () => {
    // ⛔ 「`check-release-changelog-section.mjs` を呼んでいること」を直に書かない
    //    ——script 名を歯へ焼き込むことになり、改名したときに「配線が消えた」と誤診する
    //    （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」。名前も `main` が動けば変わる側）。
    // ⟹ **形だけで選ぶ**: `node scripts/<何か>.mjs` を呼ぶ行。
    const invocations = [...workflow.matchAll(/node\s+(scripts\/[A-Za-z0-9._-]+\.mjs)/g)].map(
      (m) => m[1],
    );
    expect(invocations.length, "node scripts/*.mjs を呼ぶ行が1つも無い").toBeGreaterThanOrEqual(1);
    for (const relative of invocations) {
      expect(existsSync(join(REPO_ROOT, relative)), `${relative} が実在しない`).toBe(true);
    }
  });
});
