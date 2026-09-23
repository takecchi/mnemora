import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` の `build` ジョブが、実際に
 * `node scripts/changelog-candidates-summary.mjs`（Issue #433 方向B2 / ADR 0214 追記）を、
 * `pull_request` イベントのときだけ走らせていること。**
 *
 * ⚠ `scripts/__tests__/changelog-candidates-summary.test.mjs` の重複ではない
 * （`ci-yml-api-check-wiring.test.mjs` の docstring と同じ理由）。あちらは合成 git 履歴で
 * CLI を直接起動するだけで、**`ci.yml` を1バイトも読まない。**⟹ 誰かが `ci.yml` から
 * このステップを落としても、`if` 条件を外して毎 push で走らせるようにしても、
 * `continue-on-error` を足しても、**あちらは緑のまま通る。**この歯だけが `ci.yml` を入力に取る。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**依存追加はオーナー専権であり、
 * この歯のために YAML パーサを足さない——他の `ci-yml-*-wiring.test.mjs` と同じ判断。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "build";
const SCRIPT_INVOCATION = "node scripts/changelog-candidates-summary.mjs";

/** `jobs:` の下の1ジョブを切り出す（`ci-yml-api-check-wiring.test.mjs` と同じ形）。 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。build ジョブが消えたか名前が変わった。`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** ある行を含む「ステップ」ブロック（次の `- name:` の直前まで）を切り出す。 */
function extractStepContaining(jobBlock, needle) {
  const idx = jobBlock.indexOf(needle);
  if (idx === -1) return null;
  const stepStart = jobBlock.lastIndexOf("\n      - name:", idx);
  const nextStepIdx = jobBlock.indexOf("\n      - name:", idx);
  return jobBlock.slice(
    stepStart === -1 ? 0 : stepStart,
    nextStepIdx === -1 ? undefined : nextStepIdx,
  );
}

const jobBlock = extractJob(workflow, JOB_ID);
const stepBlock = extractStepContaining(jobBlock, SCRIPT_INVOCATION);

describe("ci.yml の build ジョブの changelog-candidates-summary 配線（Issue #433 方向B2）", () => {
  it("build ジョブに `node scripts/changelog-candidates-summary.mjs` を打つ段がある", () => {
    expect(jobBlock).toContain(SCRIPT_INVOCATION);
  });

  it("このステップは見つかる（切り出しに失敗していない——以下の検査が何も測っていない状態を防ぐ）", () => {
    expect(
      stepBlock,
      "changelog-candidates-summary を呼ぶステップが切り出せなかった",
    ).not.toBeNull();
  });

  it("🔴 `pull_request` イベントのときだけ走る（`if: github.event_name == 'pull_request'`）", () => {
    expect(stepBlock).toContain("if: github.event_name == 'pull_request'");
  });

  it("⛔ `continue-on-error:` キーは付いていない（スクリプト自体が常に0で終わるので不要——二重の安全策にしない）", () => {
    // ⚠ 素の "continue-on-error" 部分文字列で見ると、この段自身の doc コメント
    // （「continue-on-error は要らない」という説明文）に自己一致して誤検出する。
    // ⟹ 実際に効く YAML キーの形（行頭 + `continue-on-error:`）だけを見る。
    expect(stepBlock).not.toMatch(/^\s*continue-on-error:/m);
  });

  it("段名（`- name:`）は二重引用符で囲んである（ADR 0280 が踏んだ穴と同じ形を避ける）", () => {
    const nameLineMatch = /- name: (.+)/.exec(stepBlock);
    expect(nameLineMatch, "- name: 行が見つからない").not.toBeNull();
    const nameValue = nameLineMatch[1];
    expect(nameValue.startsWith('"'), `段名がダブルクォートで始まっていない: ${nameValue}`).toBe(
      true,
    );
    expect(
      nameValue.trim().endsWith('"'),
      `段名がダブルクォートで終わっていない: ${nameValue}`,
    ).toBe(true);
  });

  it("`origin/main` を明示的に fetch している（`git diff origin/main...HEAD` が解決できることに依拠するため）", () => {
    expect(stepBlock).toContain("git fetch origin main");
  });

  it("🔴 このジョブが7つ目の別ジョブではなく、既存の build ジョブへの追加である（branch protection の対象名を変えない）", () => {
    expect(jobBlock).toContain("name: typecheck / lint / test / build");
  });

  it("changelog-candidates-summary.mjs を打つのはこのジョブだけである（他ジョブへの誤配線・二重配線が無い）", () => {
    const occurrences = [...workflow.matchAll(/node scripts\/changelog-candidates-summary\.mjs/g)];
    expect(occurrences).toHaveLength(1);
  });
});
