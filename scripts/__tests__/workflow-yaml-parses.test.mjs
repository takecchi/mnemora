import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { execFileSyncWithDeadline } from "./spawn-with-deadline.mjs";

// YAML パーサの依存は足さず、開発用依存の Prettier の YAML パーサで読む（壊れていれば prettier.format が例外を投げる）。
// 対象は git ls-files から導出する（ベタ書きすると、workflow が増えたとき黙って陳腐化する）。

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function listWorkflowFiles() {
  const raw = execFileSyncWithDeadline(
    "git",
    ["ls-files", "--", ".github/workflows/*.yml", ".github/workflows/*.yaml"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return raw.split("\n").filter(Boolean);
}

/**
 * @param {string} text
 * @returns {Promise<string | null>}
 */
async function workflowYamlProblem(text) {
  try {
    await prettier.format(text, { parser: "yaml" });
  } catch (error) {
    return `YAML として読めない: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`;
  }
  if (!/^jobs:\s*(#.*)?$/m.test(text)) {
    return "最上位に `jobs:` が無い";
  }
  return null;
}

describe("workflow の YAML が構文として読める（Issue #628 件2）", () => {
  const files = listWorkflowFiles();

  it("前提: 対象の workflow が1本以上在る（空集合で緑にならない）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s は YAML として読め、最上位に jobs: を持つ", async (relPath) => {
    const text = readFileSync(join(repoRoot, relPath), "utf8");
    const problem = await workflowYamlProblem(text);
    expect(
      problem,
      `【赤の意味】${relPath} は GitHub Actions が起動できない形になっている（Issue #628 件2）。` +
        "段名などを引用符で始めて、閉じた後ろに文字を続けていないかを見ること。",
    ).toBeNull();
  });

  describe("陽性（壊れた形を赤にする）", () => {
    const valid = [
      "name: sample",
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: 'quoted whole' # 引用符で閉じた正しい形",
      "        run: echo hi",
      "",
    ].join("\n");

    it("正しい形は通す（引用符で全体を囲んだ段名を含む）", async () => {
      expect(await workflowYamlProblem(valid)).toBeNull();
    });

    it("件2 の形（段名を引用符で始め、閉じた後ろに文字を続ける）を YAML として読めないと言う", async () => {
      const broken = valid.replace(
        "- name: 'quoted whole' # 引用符で閉じた正しい形",
        "- name: 'omitted' の段",
      );
      expect(broken).not.toBe(valid);
      expect(await workflowYamlProblem(broken)).toMatch(/^YAML として読めない/);
    });

    it("最上位に jobs: が無ければ赤にする", async () => {
      const noJobs = valid.replace(/^jobs:$/m, "jobz:");
      expect(noJobs).not.toBe(valid);
      expect(await workflowYamlProblem(noJobs)).toBe("最上位に `jobs:` が無い");
    });
  });
});
