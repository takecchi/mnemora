import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { isDraftOnlyJobIf } from "../ci-draft-skip-lib.mjs";

/**
 * YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。
 * `blankOutWorkflowComments` を通してから照合する（地の文のコメントが引用しているだけでも一致してしまう）。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: workflowUnhandled } = blankOutWorkflowComments(rawWorkflow);

const JOB_ID = "example-chat";

/**
 * @param {string} yaml
 * @param {string} jobId
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い(見つからなくなった)。`);
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

/**
 * @param {string} jobBlock
 * @returns {string[]}
 */
function splitSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error("ジョブブロックに `    steps:` が無い。");
  }
  /** @type {string[]} */
  const chunks = [];
  /** @type {string[]} */
  let current = [];
  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {6}- name: /.test(line)) {
      if (current.length > 0) {
        chunks.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

const jobBlock = extractJob(workflow, JOB_ID);
const steps = splitSteps(jobBlock);

const testDbStepIndex = steps.findIndex((step) =>
  step.includes("run: pnpm --filter @mnemora/example-chat run test:db"),
);
const fingerprintStepIndex = steps.findIndex((step) =>
  step.includes("check-local-embedding-fingerprint.mjs"),
);

describe("ci.yml の local-embedding fingerprint 配線(example-chat ジョブ)", () => {
  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(workflowUnhandled).toEqual([]);
  });

  it("test:db ステップが見つかる(このテスト自身の土台)", () => {
    expect(testDbStepIndex).toBeGreaterThanOrEqual(0);
  });

  it("⭐ check-local-embedding-fingerprint.mjs を実行するステップが存在する", () => {
    expect(fingerprintStepIndex).toBeGreaterThanOrEqual(0);
  });

  it("🔴 fingerprint ステップは test:db ステップより後にある(モデルはテスト実行中に取得されるため)", () => {
    expect(fingerprintStepIndex).toBeGreaterThan(testDbStepIndex);
  });

  it("MNEMORA_LOCAL_EMBEDDING_CACHE_DIR を渡している", () => {
    const step = steps[fingerprintStepIndex];
    expect(step).toContain("MNEMORA_LOCAL_EMBEDDING_CACHE_DIR");
  });

  it("⛔ continue-on-error を持たない(この段は門である)", () => {
    const step = steps[fingerprintStepIndex];
    expect(/^\s*["']?continue-on-error["']?\s*:/m.test(step)).toBe(false);
  });

  it("⛔ 門のステップは `if:` を持たない(`if: false` などで走らなくする書き方を許さない)", () => {
    const step = steps[fingerprintStepIndex];
    // ステップのキーは 8 桁のインデント(`      - name:` の続き)。`run:` の本文の中の `if` は深いので当たらない。
    expect(/^ {8}["']?if["']?\s*:/m.test(step)).toBe(false);
  });

  it("⛔ 門が居るジョブ(example-chat)は、ジョブの側でも `continue-on-error` と `if:` を持たない（draft の PR でだけ飛ばす1行は除く）", () => {
    expect(/^ {4}["']?continue-on-error["']?\s*:/m.test(jobBlock)).toBe(false);
    expect(
      jobBlock.split("\n").filter((l) => /^ {4}["']?if["']?\s*:/.test(l) && !isDraftOnlyJobIf(l)),
    ).toEqual([]);
  });

  it("⭐ ステップの本体が GITHUB_STEP_SUMMARY へ書き出している(一致・保留のどちらでも1行残す設計)", () => {
    const step = steps[fingerprintStepIndex];
    expect(step).toContain("GITHUB_STEP_SUMMARY");
  });

  it("⚠ 陰性対照: 架空のステップ名では見つからない(検査そのものが常に true を返すだけに退化していないことの根拠)", () => {
    const bogusIndex = steps.findIndex((step) =>
      step.includes("check-nonexistent-fingerprint-tool.mjs"),
    );
    expect(bogusIndex).toBe(-1);
  });
});
