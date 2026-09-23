import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/` の workflow ファイルが、YAML として構文上読めること、
 * そして最上位に `jobs:` を持つこと**（Issue #628 の件2）。
 *
 * 件2 で実際に起きたこと: `ci.yml` に段を足す際、段名を `'omitted' の …` と書いた
 * ⟹ YAML が先頭のシングルクォートを引用符として読んで壊れ、**workflow がそもそも
 * 起動しなかった**（`jobs` が0件のまま `failure`。PR #625 / ADR 0280）。そのとき、
 * 手元のテストはすべて緑だった——既存の `ci-yml-*-wiring` の歯は、どれも docstring で
 * 「YAML は構造として解析していない（文字列で見ている）」と断っている。⟹ **YAML が
 * 構文として読めるかを見る門が、repo に1つも無かった。**`pnpm run format:check` も
 * YAML を対象にしていない（`*.{ts,tsx,mts,cts,js,mjs,cjs,json}` だけを見る）。
 *
 * ## 読み方
 *
 * - **対象は `git ls-files` から導出する**（ベタ書きしない——workflow が増えたとき、
 *   この歯が黙って陳腐化しないため）。
 * - **YAML パーサの依存は足さない**（依存の追加はオーナー専権。`docs/autonomy.md`）。
 *   既存の開発用の依存である Prettier の YAML パーサで読む。構文が壊れていれば
 *   `prettier.format` が例外を投げる。
 * - **`jobs:` は最上位の行として在るかだけを見る**（件2 の「`jobs` が0件」の形）。
 *   各ジョブの中身は見ない——それは既存の `ci-yml-*-wiring` の歯の持ち場である。
 * - ⛔ **workflow ファイルは読むだけで、1バイトも書き換えない**（`publish.yml` を含む）。
 *
 * ## この歯が測っていないこと
 *
 * - **GitHub Actions としての妥当性**（`on:` の書式、`runs-on:` の値、式 `${{ }}` の
 *   中身など）は見ない。構文として読める YAML でも、Actions が受け付けない形はある。
 * - **Prettier の YAML パーサが、GitHub の YAML パーサと同じ判定をすること**は
 *   確かめていない。件2 の形（引用符で始まって、閉じた後ろに文字が続くスカラー）で
 *   両者が同じく壊れることは、下の陽性の歯が固定している。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** `git ls-files` から、`.github/workflows/` 直下の YAML ファイルを導出する。 */
function listWorkflowFiles() {
  const raw = execFileSync(
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
 * workflow の本文を当てて、壊れていれば理由を返す（壊れていなければ `null`）。
 *
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
