import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { EMBEDDING_FINGERPRINT_JOBS } from "../compare-embedding-output-fingerprints-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` に、Issue #565（案A: 測るだけ。門にしない）の配線が
 * 実際に在ること**——
 *
 * 1. `EMBEDDING_FINGERPRINT_JOBS`（`example-chat` / `root-gate-db-stage`）の各ジョブが、
 *    `embedding-fingerprint` サブコマンドを呼び、`scripts/measure-embedding-output-
 *    fingerprint.mjs` で測定 JSON を合成し、`scripts/embedding-output-fingerprint-
 *    summary.mjs` で Job Summary へ残し、`actions/upload-artifact@v6` で
 *    `job.artifactName` を artifact 名として（`if: always()` / `if-no-files-found:
 *    ignore` で）アップロードしていること。
 * 2. 比較段（新しいジョブ）が両ジョブに `needs:` で依存し、`if: always()` で走り、
 *    `actions/download-artifact@v6` で `pattern: embedding-output-fingerprint-*` を
 *    使い、`scripts/compare-embedding-output-fingerprints.mjs` を呼んでいること。
 * 3. 足した段・ジョブの `name:` が二重引用符で囲まれていること（ADR 0280 が踏んだ穴——
 *    `#565` の直前に半角空白が在ると YAML コメントとして読まれ、check の名前が
 *    黙って途中で切れる）。
 *
 * ⚠ **これは `measure-embedding-output-fingerprint-lib.test.mjs` /
 * `compare-embedding-output-fingerprints-lib.test.mjs` の重複ではない。**
 * それらは**自分で入力を作って**純関数の振る舞いを測るだけで、`ci.yml` を1バイトも
 * 読まない——誰かが `ci.yml` から呼び出しを落としても、artifact 名を打ち間違えても、
 * `needs:` を片方だけにしても、その2本は緑のまま通る（`ci-yml-identifier-probes-
 * wiring.test.mjs` と同じ理由）。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。** 既存の wiring 歯と
 * 同じ判断（依存追加はオーナー専権、`docs/autonomy.md`）。壊れたときは「配線が
 * 変わった」か「書き方が変わった」かを見て、配線が変わっていないなら取り出し方の
 * ほうを直すこと（歯を消さないこと）。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: workflowUnhandled } = blankOutWorkflowComments(rawWorkflow);

/**
 * `jobs:` の下の1ジョブ（`  <id>:` から、次の同じ深さの `  <id>:` まで）を切り出す。
 * `ci-yml-identifier-probes-wiring.test.mjs` の `extractJob` と同じ形。
 *
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
    // upload-artifact のブロックは `- name: "..."` から始まる段の中に在る。
    // その段の先頭(直近の `- name:`)まで遡り、段全体に if: always() / if-no-files-found を探す。
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
    // このジョブの中で、Issue #565 が足した段の name をすべて拾い、
    // 生テキスト(コメント潰し前)で引用符付きであることを確かめる。
    // 🔴 コメント潰し後のテキストで拾うと、コメント潰しが引用符を保持したまま
    // 中身だけ空白に潰す実装であることに依存してしまう——ここでは生テキストの
    // 該当ジョブブロックに対して直接確認する。
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
    // 「比較段自身のジョブ id」は実装側が自由に選べるので名前では決め打たず、
    // 両方の job id を持つ `needs:` の行を手がかりに逆引きする。
    const needsLineIndex = lines.findIndex(
      (line) => jobIds.every((id) => line.includes(id)) && line.trim().startsWith("needs:"),
    );
    expect(needsLineIndex).toBeGreaterThan(-1);
    // needs: から次の `runs-on:` までの間(コメントを挟みうるので広めに取る)に
    // if: always() が在ることを確認する。
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
