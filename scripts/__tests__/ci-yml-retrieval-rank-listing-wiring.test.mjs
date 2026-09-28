import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * `retrieval-rank-listing` ジョブ(Issue #572、ADR 0276 の 2026-09-28 の追記)が
 * **門にならない配線のまま**であることを固定する歯。
 *
 * 固定する4つ:
 * 1. `.github/required-status-checks.json` の `contexts` に、このジョブの表示名が無い。
 * 2. このジョブ自身が `needs:` を持たない(既存ジョブの鎖に繋がない)。
 * 3. 他のどのジョブの `needs:` にも、このジョブの id が無い(このジョブの失敗が他を止めない)。
 * 4. 一覧を出す段が、終了コードを握りつぶしていない(`|| true` を付けない)——
 *    **bench が壊れたときに落ちる**ことを、配線の側で守る。順位で落ちないことは
 *    `examples/chat/src/__tests__/retrieval-rank-listing.test.ts` が純関数の側で守る。
 *
 * ⛔ **この歯は branch protection そのものを読まない。**`required-status-checks.json` は写しであり、
 * 実物との突き合わせは `pnpm check:required-status-checks`(手で実行)の役目である(ADR 0279)。
 *
 * ⚠ YAML は構造として解析せず、文字列で見ている(既存の wiring テストと同じ判断)。
 * `skip`・`if:`・`continue-on-error` は `ci-yml-measurement-jobs-wiring.test.mjs` が見る。
 */

const JOB_ID = "retrieval-rank-listing";
const CI_WORKFLOW_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const REQUIRED_PATH = fileURLToPath(
  new URL("../../.github/required-status-checks.json", import.meta.url),
);

/** @param {string} text @param {string} jobId */
function extractJobBlock(text, jobId) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    return null;
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

/** @param {string} jobBlock */
function jobDisplayName(jobBlock) {
  const match = /^ {4}name:\s*(.+)$/m.exec(jobBlock);
  if (!match) {
    return null;
  }
  return match[1].trim().replace(/^"(.*)"$/, "$1");
}

/** `needs:` の値(1行形式 `needs: a` / `needs: [a, b]`)から job id を取り出す。 */
function needsTargets(workflow) {
  const targets = [];
  for (const match of workflow.matchAll(/^ {4}needs:\s*(.+)$/gm)) {
    const raw = match[1].trim().replace(/^\[|\]$/g, "");
    targets.push(
      ...raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return targets;
}

const blanked = blankOutWorkflowComments(readFileSync(CI_WORKFLOW_PATH, "utf-8"));
const workflow = blanked.text;

describe(`ci.yml の ${JOB_ID} ジョブは門にならない配線のまま(Issue #572)`, () => {
  const block = extractJobBlock(workflow, JOB_ID);

  it("コメントの潰しが判定できない行を残していない", () => {
    expect(blanked.unhandled).toEqual([]);
  });

  it("ジョブが在り、表示名を取り出せる", () => {
    expect(block).not.toBeNull();
    expect(jobDisplayName(/** @type {string} */ (block))).toBeTruthy();
  });

  it("表示名が required-status-checks.json の contexts に無い", () => {
    const required = JSON.parse(readFileSync(REQUIRED_PATH, "utf-8"));
    const name = jobDisplayName(/** @type {string} */ (block));
    expect(required.contexts).not.toContain(name);
  });

  it("このジョブ自身が needs: を持たない", () => {
    expect(/^ {4}needs:/m.test(/** @type {string} */ (block))).toBe(false);
  });

  it("他のどのジョブの needs: にも、このジョブの id が無い", () => {
    expect(needsTargets(workflow)).not.toContain(JOB_ID);
  });

  it("一覧を出す段が終了コードを握りつぶしていない(|| true が無い)", () => {
    const runLine = /** @type {string} */ (block)
      .split("\n")
      .find((line) => line.includes("run retrieval-rank-listing"));
    expect(runLine, "一覧を出す段が見つからない").toBeDefined();
    expect(runLine).not.toMatch(/\|\|/);
  });
});

describe("陽性対照: 取り出し方そのものが違反を捕まえる", () => {
  it("needs: の2形式を読める(既存の鎖が実際に拾えている)", () => {
    expect(needsTargets(workflow).length).toBeGreaterThan(0);
    expect(needsTargets("    needs: [a, retrieval-rank-listing]\n")).toContain(JOB_ID);
    expect(needsTargets("    needs: retrieval-rank-listing\n")).toContain(JOB_ID);
  });

  it("表示名が contexts に入っていれば検出できる", () => {
    const synthetic = [`  ${JOB_ID}:`, '    name: "x"', "    runs-on: ubuntu-latest"].join("\n");
    const name = jobDisplayName(/** @type {string} */ (extractJobBlock(synthetic, JOB_ID)));
    expect(["x"]).toContain(name);
  });
});
