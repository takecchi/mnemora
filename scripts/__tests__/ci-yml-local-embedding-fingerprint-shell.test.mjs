import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * run: 本文は ci.yml から逐語で取り出し、1文字も置換せずに bash へ渡す
 * （置換すると、ci.yml の本文とこの歯が検査する対象がずれる）。
 * bash は GitHub Actions の `shell:` 未指定の既定に合わせて `-o pipefail` なしで起動する。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");

/**
 * `run: |` ブロックを yml から切り出す。`blankOutWorkflowComments` は通さない
 * （本文を書き換えずに bash へ渡すため）。
 *
 * @param {string} text
 * @returns {{ startLine: number, indent: number, body: string }[]}
 */
function extractRunBlocks(text) {
  const lines = text.split("\n");
  /** @type {{ startLine: number, indent: number, body: string }[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(/^( +)run:\s*\|\s*$/);
    if (!match) {
      i += 1;
      continue;
    }
    const indent = match[1].length;
    const startLine = i + 1;
    /** @type {string[]} */
    const bodyLines = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") {
        bodyLines.push(line);
        continue;
      }
      const lineIndent = line.match(/^ */)[0].length;
      if (lineIndent <= indent) break;
      bodyLines.push(line);
    }
    blocks.push({ startLine, indent, body: bodyLines.join("\n") });
    i = j;
  }
  return blocks;
}

const runBlocks = extractRunBlocks(rawWorkflow);
// ステップ名では選ばない（名前が変わると歯が古いまま緑になる）。
const fingerprintCandidates = runBlocks.filter((block) =>
  block.body.includes("check-local-embedding-fingerprint.mjs"),
);
const fingerprintBlock = fingerprintCandidates.length === 1 ? fingerprintCandidates[0] : undefined;

/**
 * @param {string} body `run:` ブロックの本文(1バイトも書き換えない)
 * @param {number} fakeNodeExitCode `node` の代わりに置く偽物が返す終了コード
 * @returns {{ status: number | null, stdout: string, stderr: string, summaryLines: string[] }}
 */
function runFingerprintStepBody(body, fakeNodeExitCode) {
  const scratch = mkdtempSync(join(tmpdir(), "fingerprint-shell-"));
  const binDir = join(scratch, "bin");
  mkdirSync(binDir);

  // 本文は書き換えず、PATH で `node` を差し替える。
  const fakeNodePath = join(binDir, "node");
  writeFileSync(fakeNodePath, `#!/bin/sh\nexit ${fakeNodeExitCode}\n`, { mode: 0o755 });

  const scriptPath = join(scratch, "step.sh");
  writeFileSync(scriptPath, body);

  const summaryPath = join(scratch, "GITHUB_STEP_SUMMARY.md");
  writeFileSync(summaryPath, "");

  const cacheDir = join(scratch, "cache-does-not-need-to-exist");

  const result = spawnSyncWithDeadline("bash", ["--noprofile", "--norc", "-e", scriptPath], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      GITHUB_STEP_SUMMARY: summaryPath,
      MNEMORA_LOCAL_EMBEDDING_CACHE_DIR: cacheDir,
    },
    encoding: "utf8",
  });

  const summaryContent = readFileSync(summaryPath, "utf8");
  const summaryLines = summaryContent.split("\n").filter((line) => line.length > 0);

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    summaryLines,
  };
}

describe("ci.yml の local-embedding fingerprint ステップの run: 本文をシェルとして実行する(Issue #574)", () => {
  it("この歯は ci.yml を実際に読んでいる(読めなければ以下は何も測っていない)", () => {
    expect(rawWorkflow, `${workflowPath} が読めなかった`).not.toBe("");
    expect(
      rawWorkflow.length,
      "ci.yml が短すぎる——別ファイルを読んでいる可能性がある",
    ).toBeGreaterThanOrEqual(1000);
  });

  it("check-local-embedding-fingerprint.mjs を呼ぶ run: ブロックが、ちょうど1つに定まる", () => {
    expect(
      fingerprintCandidates.length,
      "check-local-embedding-fingerprint.mjs を含む run: | ブロックが、ci.yml にちょうど1つ" +
        `在ることを期待した(見つかった数: ${fingerprintCandidates.length})——0 なら配線が` +
        "変わった。2以上なら、どれが対象かをこの歯が決められない" +
        "(⛔ 黙ってどちらかを選ばない。取り出し方のほうを直すこと)。",
    ).toBe(1);
    expect(fingerprintBlock, "対象の run: | ブロックを取り出せなかった").toBeDefined();
  });

  it("⚠ 陰性対照: 取り出した本文が空文字列へ退化していない(case/対象スクリプト名/GITHUB_STEP_SUMMARY を含む)", () => {
    expect(fingerprintBlock, "前の it が失敗している場合、ここも意味を持たない").toBeDefined();
    const body = fingerprintBlock?.body ?? "";
    // 抽出に失敗して空文字列になると bash は成功終了し、exit 0 の it だけが偶然緑になる。
    expect(body).toContain("check-local-embedding-fingerprint.mjs");
    expect(body).toContain("case");
    expect(body).toContain("GITHUB_STEP_SUMMARY");
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it.runIf(fingerprintBlock !== undefined)(
    "exit 0(match) → シェルは成功終了。::warning:: は出ない。GITHUB_STEP_SUMMARY に🟢の1行",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 0);
      expect(status).toBe(0);
      expect(stdout).not.toContain("::warning::");
      expect(summaryLines).toHaveLength(1);
      expect(summaryLines[0]).toContain("🟢");
      expect(summaryLines[0]).toContain("一致した");
    },
  );

  it.runIf(fingerprintBlock !== undefined)(
    "exit 1(mismatch) → シェルは exit 1(ジョブは失敗)。::warning:: は出ない。GITHUB_STEP_SUMMARY には何も書かれない",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 1);
      expect(status).toBe(1);
      expect(stdout).not.toContain("::warning::");
      expect(summaryLines).toHaveLength(0);
    },
  );

  it.runIf(fingerprintBlock !== undefined)(
    "exit 2(undetermined/保留) → シェルは成功終了(ジョブは落ちない)。::warning:: が stdout に出る。GITHUB_STEP_SUMMARY に🟡の1行",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 2);
      expect(status).toBe(0);
      expect(stdout).toContain("::warning::");
      expect(stdout).toContain("保留した");
      expect(summaryLines).toHaveLength(1);
      expect(summaryLines[0]).toContain("🟡");
      expect(summaryLines[0]).toContain("判定していない");
    },
  );

  it.runIf(fingerprintBlock !== undefined)(
    "exit 3(実行時エラー) → シェルは exit 3(ジョブは失敗)。::warning:: は出ない。GITHUB_STEP_SUMMARY には何も書かれない",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 3);
      expect(status).toBe(3);
      expect(stdout).not.toContain("::warning::");
      expect(summaryLines).toHaveLength(0);
    },
  );
});
