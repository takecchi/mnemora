import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { EMBEDDING_FINGERPRINT_JOBS } from "../compare-embedding-output-fingerprints-lib.mjs";

/** YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。壊れたときは、配線が変わったのか書き方が変わったのかを見て、配線が変わっていないなら取り出し方を直す。 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: workflowUnhandled } = blankOutWorkflowComments(rawWorkflow);

/**
 * @param {string} yaml
 * @param {string} jobId
 * @returns {string}
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い（無ければ配線を測れない）。`);
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

it("blankOutWorkflowComments が ci.yml 全体を扱えている（unhandled が空）", () => {
  expect(workflowUnhandled).toEqual([]);
});

it("EMBEDDING_FINGERPRINT_JOBS が2件以上ある（この歯自体が空回りしていないこと）", () => {
  expect(EMBEDDING_FINGERPRINT_JOBS.length).toBeGreaterThanOrEqual(2);
});

describe.each(EMBEDDING_FINGERPRINT_JOBS)("$id ジョブへの測る段の配線", ({ id, artifactName }) => {
  const jobBlock = extractJob(workflow, id);

  it("embedding-fingerprint サブコマンドを呼んでいる", () => {
    expect(jobBlock).toContain("run embedding-fingerprint");
  });

  it("scripts/measure-embedding-output-fingerprint.mjs を呼んでいる", () => {
    expect(jobBlock).toContain("node scripts/measure-embedding-output-fingerprint.mjs");
  });

  it("scripts/embedding-output-fingerprint-summary.mjs を --measured 付きで呼んでいる", () => {
    expect(jobBlock).toContain("node scripts/embedding-output-fingerprint-summary.mjs");
    expect(jobBlock).toContain("--measured");
  });

  it(`artifact 名 ${artifactName} で upload-artifact@v6 を使っている`, () => {
    expect(jobBlock).toContain("uses: actions/upload-artifact@v6");
    expect(jobBlock).toContain(`name: ${artifactName}`);
  });

  it("artifact のアップロード段が if: always() かつ if-no-files-found: ignore である", () => {
    const lines = jobBlock.split("\n");
    const nameIndex = lines.findIndex((line) => line.trim() === `name: ${artifactName}`);
    expect(nameIndex).toBeGreaterThan(-1);
    let stepStart = nameIndex;
    while (stepStart > 0 && !/^ {6}- name:/.test(lines[stepStart])) {
      stepStart -= 1;
    }
    let stepEnd = lines.length;
    for (let i = nameIndex + 1; i < lines.length; i += 1) {
      if (/^ {6}- name:/.test(lines[i])) {
        stepEnd = i;
        break;
      }
    }
    const stepBlock = lines.slice(stepStart, stepEnd).join("\n");
    expect(stepBlock).toContain("if: always()");
    expect(stepBlock).toContain("if-no-files-found: ignore");
  });

  it("足した段の name: が二重引用符で囲まれている（ADR 0280 の穴の回避）", () => {
    // コメント潰し後ではなく生テキストで確かめる。潰し後だと、引用符を保持したまま中身だけ空白にする実装に依存してしまう。
    const rawJobBlock = extractJob(rawWorkflow, id);
    const nameLines = rawJobBlock
      .split("\n")
      .filter((line) => /^ {6}- name: /.test(line) && line.includes("#565"));
    expect(nameLines.length).toBeGreaterThan(0);
    for (const line of nameLines) {
      const value = line.replace(/^ {6}- name: /, "");
      expect(value.startsWith('"'), `引用符で囲まれていない: ${line}`).toBe(true);
    }
  });
});

describe("2ジョブの指紋を突き合わせる比較段の配線", () => {
  it("EMBEDDING_FINGERPRINT_JOBS の id を needs: に持つジョブが在る", () => {
    const lines = workflow.split("\n");
    const jobIds = EMBEDDING_FINGERPRINT_JOBS.map((job) => job.id);
    const needsLineIndex = lines.findIndex(
      (line) => jobIds.every((id) => line.includes(id)) && line.trim().startsWith("needs:"),
    );
    expect(needsLineIndex, "needs: に両方の job id を持つ行が見つからない").toBeGreaterThan(-1);
  });

  it("compare-embedding-output-fingerprints.mjs を --artifacts-dir 付きで呼んでいる", () => {
    expect(workflow).toContain("node scripts/compare-embedding-output-fingerprints.mjs");
    expect(workflow).toContain("--artifacts-dir");
  });

  it("actions/download-artifact@v6 を pattern: embedding-output-fingerprint-* で使っている", () => {
    expect(workflow).toContain("uses: actions/download-artifact@v6");
    expect(workflow).toContain("pattern: embedding-output-fingerprint-*");
  });

  it("比較段のジョブに if: always() が付いている（片方のジョブが落ちても比較を試みる）", () => {
    const lines = workflow.split("\n");
    const jobIds = EMBEDDING_FINGERPRINT_JOBS.map((job) => job.id);
    // 比較段のジョブ id は名前で決め打たず、両方の job id を持つ `needs:` の行から逆引きする。
    const needsLineIndex = lines.findIndex(
      (line) => jobIds.every((id) => line.includes(id)) && line.trim().startsWith("needs:"),
    );
    expect(needsLineIndex).toBeGreaterThan(-1);
    let runsOnIndex = lines.findIndex(
      (line, i) => i > needsLineIndex && line.trim().startsWith("runs-on:"),
    );
    if (runsOnIndex === -1) {
      runsOnIndex = needsLineIndex + 20;
    }
    const nearby = lines.slice(needsLineIndex, runsOnIndex).join("\n");
    expect(nearby).toContain("if: always()");
  });
});
