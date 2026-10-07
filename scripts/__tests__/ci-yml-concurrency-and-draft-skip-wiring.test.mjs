import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRAFT_ONLY_JOB_IF } from "../ci-draft-skip-lib.mjs";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * 再確かめ（2026-10-07 マージ分、#1896）。#1896 は ci.yml と embedding-cross-runner-reproducibility.yml に
 * 「PR は後勝ち・main への push は切らない」「draft の PR では全 job を飛ばし、ready_for_review で走り直す」を足した。
 * 元の歯4本は「draft の1行だけは job レベルの if: に許す」側に緩めただけで、この約束そのものを縛る歯が無かった。
 * YAML は構造として解析せず、コメントを潰した文字列で見る（依存追加はオーナー専権）。
 */

const WORKFLOWS = {
  "ci.yml": fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
  "embedding-cross-runner-reproducibility.yml": fileURLToPath(
    new URL("../../.github/workflows/embedding-cross-runner-reproducibility.yml", import.meta.url),
  ),
};

const CONCURRENCY_BLOCK = [
  "concurrency:",
  "  group: ${{ github.workflow }}-${{ github.event_name == 'push' && github.ref || github.head_ref || github.run_id }}",
  "  cancel-in-progress: ${{ github.event_name != 'push' }}",
].join("\n");

const DRAFT_COND = DRAFT_ONLY_JOB_IF.replace(/^ {4}if: /, "");
const ALLOWED_JOB_IFS = [DRAFT_ONLY_JOB_IF, `    if: always() && (${DRAFT_COND})`];

/** @param {string} path @returns {string} */
function blanked(path) {
  return blankOutWorkflowComments(readFileSync(path, "utf8")).text;
}

/**
 * トップレベルの job id と、その job レベル（4 字下げ）の `if:` の行（無ければ null）。
 * @param {string} text
 * @returns {Array<{ id: string; ifLine: string | null }>}
 */
function jobsWithIf(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  expect(start, "jobs: が見つからない").toBeGreaterThanOrEqual(0);
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) {
      jobs.push({ id: id[1], ifLine: null });
      continue;
    }
    if (jobs.length > 0 && /^ {4}if:/.test(line)) {
      jobs.at(-1).ifLine = line.trimEnd();
    }
  }
  return jobs;
}

describe("ci.yml・embedding-cross-runner-reproducibility.yml: 後勝ち（concurrency）と draft の PR を飛ばす約束", () => {
  describe.each(Object.entries(WORKFLOWS))("%s", (_name, path) => {
    const text = blanked(path);

    it("concurrency は、PR を head_ref で群にして古い実行を取り消し、push は ref で群にして取り消さない", () => {
      expect(text).toContain(CONCURRENCY_BLOCK);
    });

    it("pull_request は ready_for_review を含み（draft を ready にしたら走り直す）、opened・synchronize・reopened も外さない", () => {
      const m = /^ {2}pull_request:\n {4}types: \[([^\]]*)\]/m.exec(text);
      expect(m, "pull_request の types: が見つからない").not.toBeNull();
      const types = m[1].split(",").map((t) => t.trim());
      expect(types).toEqual(
        expect.arrayContaining(["opened", "synchronize", "reopened", "ready_for_review"]),
      );
    });

    it("全 job に、draft の PR では飛ばす job レベルの if: が付く（always() の job は always() && (…)）", () => {
      const jobs = jobsWithIf(text);
      expect(jobs.length).toBeGreaterThan(0);
      for (const { id, ifLine } of jobs) {
        expect(ALLOWED_JOB_IFS, `job ${id} の if:（${ifLine}）`).toContain(ifLine);
      }
    });
  });

  it("🔴 陰性対照: jobsWithIf は if: の無い job・条件を足した if: を、許す形から外す", () => {
    const synthetic = [
      "jobs:",
      "  a:",
      "    runs-on: x",
      "  b:",
      `${DRAFT_ONLY_JOB_IF} && github.event_name == 'push'`,
      "  c:",
      DRAFT_ONLY_JOB_IF,
      "    steps:",
      "      - if: always()",
    ].join("\n");
    const jobs = jobsWithIf(synthetic);
    expect(jobs.map((j) => j.id)).toEqual(["a", "b", "c"]);
    expect(jobs.map((j) => ALLOWED_JOB_IFS.includes(j.ifLine))).toEqual([false, false, true]);
  });
});
