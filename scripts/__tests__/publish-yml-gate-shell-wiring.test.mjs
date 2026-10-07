import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

// YAML は文字列で見る（依存を足さない）。注釈の中の `shell:` で赤くならないよう、
// blankOutWorkflowComments でコメントを潰してから判定する。
// `-e` を保つ確認は、将来 run: | へ別の行が足されたときの防御として残してある。

const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));
const runPublishGatesPath = fileURLToPath(new URL("../run-publish-gates.mjs", import.meta.url));

const workflowRaw = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: commentUnhandled } = blankOutWorkflowComments(workflowRaw);

// steps: の構造やステップ名には依存しない（名前が変わると歯が古いまま緑になる）。
/**
 * @param {string} text コメントを潰した後の本文
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

/**
 * @param {string} text コメントを潰した後の本文
 * @returns {{ lineNumber: number, value: string }[]}
 */
function extractShellOverrides(text) {
  const lines = text.split("\n");
  /** @type {{ lineNumber: number, value: string }[]} */
  const overrides = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*shell:\s*(.+?)\s*$/);
    if (!match) return;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    overrides.push({ lineNumber: index + 1, value });
  });
  return overrides;
}

const runBlocks = extractRunBlocks(workflow);
// ステップ名には依存せず、run-publish-gates.mjs を含む run: | ブロックで探す。
const gateCandidates = runBlocks.filter((block) => block.body.includes("run-publish-gates.mjs"));
const gateBlock = gateCandidates.length === 1 ? gateCandidates[0] : undefined;
const shellOverrides = extractShellOverrides(workflow);

const ALLOWED_SHELLS = new Set(["bash", "sh"]);

describe(".github/workflows/publish.yml の門ステップが既定シェル（bash -e）で走るという前提が縛られていること（Issue #476）", () => {
  it("この歯は publish.yml を実際に読んでいる（読めなければ以下は何も測っていない）", () => {
    expect(workflowRaw, `${workflowPath} が読めなかった`).not.toBe("");
    expect(
      workflowRaw.length,
      "publish.yml が短すぎる——別ファイルを読んでいる可能性がある",
    ).toBeGreaterThanOrEqual(1000);
    expect(
      commentUnhandled,
      "コメント潰しが扱えない形に当たった——以下の shell: の判定の土台が信用できない" +
        `（unhandled: ${JSON.stringify(commentUnhandled)}）`,
    ).toEqual([]);
  });

  it("門ステップ（非 DB の門を全部通す段）が実在し、run-publish-gates.mjs をちょうど1回だけ、余計な尾を付けずに呼んでいる", () => {
    expect(
      gateCandidates.length,
      "run-publish-gates.mjs を含む run: | ブロックが、publish.yml にちょうど1つ在ることを期待した" +
        `（見つかった数: ${gateCandidates.length}）——0 なら門ステップが script 呼び出しに` +
        "なっていない（bash -e に任せるインライン実装へ戻った可能性がある)。" +
        "2以上なら、どれが門ステップかをこの歯が決められない" +
        "（⛔ 黙ってどちらかを選ばない。取り出し方のほうを直すこと）",
    ).toBe(1);
    expect(gateBlock, "門ステップの run: | ブロックを取り出せなかった").toBeDefined();
    expect(
      gateBlock.body.trim(),
      "門ステップの run: | ブロックが node scripts/run-publish-gates.mjs 単独の1行になっていない" +
        `（実際の中身: ${JSON.stringify(gateBlock.body)}）——前後に余計なコマンドが繋がっていると、` +
        "run-publish-gates.mjs の終了コードがステップの終了コードとしてそのまま使われる保証が崩れる",
    ).toBe("node scripts/run-publish-gates.mjs");
  });

  it("workflow 全体に defaults: ブロックが無い（既定シェルを黙って差し替えていない）", () => {
    expect(workflow).not.toMatch(/^ {0,2}defaults:\s*$/m);
  });

  it("シェルを上書きしている段が在るなら、それは -e を保つ shell に限られる", () => {
    const offending = shellOverrides.filter((override) => !ALLOWED_SHELLS.has(override.value));
    const offendingLines = offending
      .map((override) => `  ${override.lineNumber}: shell: ${override.value}`)
      .join("\n");
    const message =
      `.github/workflows/publish.yml が、既定シェルの -e を失う形で shell を上書きしている:\n\n` +
      `${offendingLines}\n\n` +
      `⟹ なぜこれが赤いのか:\n` +
      `  Issue #476 の判定「偽陽性の緑は起きない」は、門ステップが GitHub Actions の\n` +
      `  既定シェル（bash -e）で走ることに全面的に依存している。-e を失うと、\n` +
      `  前段のコマンドが落ちてもステップが緑で終わりうる——リリース経路に\n` +
      `  「壊れているのに通る」が戻る。\n` +
      `⟹ どうすればよいか:\n` +
      `  shell: を上書きしないか、-e を保つ形（bash / sh）にすること。\n` +
      `  意図して別のシェルに変えるなら、Issue #476 の判定そのものが成り立たなく\n` +
      `  なるので、判定を引き直してからこの歯を更新すること。\n` +
      `  ⛔ この歯を通すために publish.yml の門ステップを1段ずつに割らないこと\n` +
      `     （それは別の判断である。ADR 0210 の6番を読むこと）。`;
    expect(offending, message).toEqual([]);
  });

  it("shell を、キーが行頭でない書き方（`- shell:`・引用符つきのキー・{ } の中）で上書きしても、-e を保つ shell に限られる（Issue #1804）", () => {
    const found = [...workflow.matchAll(/(?:^|[\s{,])["']?shell["']?\s*:\s*([^\n,}]+)/g)].map((m) =>
      m[1].trim().replace(/^(["'])(.*)\1$/, "$2"),
    );
    const offending = found.filter((value) => !ALLOWED_SHELLS.has(value));
    expect(
      offending,
      `publish.yml が、-e を失う形で shell を上書きしている（キーの書き方によらず検出）: ${JSON.stringify(offending)}`,
    ).toEqual([]);
  });

  it("門ステップは条件で飛ばされない（step に if: を持たず、継続を握り潰すキーも持たない。キーを引用符で囲んでも同じ）（Issue #1804）", () => {
    expect(gateBlock, "門ステップが無い").toBeDefined();
    const lines = workflow.split("\n");
    const dashIndent = gateBlock.indent - 2;
    let start = gateBlock.startLine - 1;
    while (start >= 0 && !new RegExp(`^ {${dashIndent}}- `).test(lines[start])) start -= 1;
    expect(start, "門ステップの先頭（`- `）が見つからない").toBeGreaterThanOrEqual(0);
    let end = start + 1;
    while (
      end < lines.length &&
      (lines[end].trim() === "" || lines[end].match(/^ */)[0].length > dashIndent)
    ) {
      end += 1;
    }
    const stepText = lines.slice(start, end).join("\n");
    expect(stepText, "門ステップに if: が付いている").not.toMatch(/(?:^|[\s{,-])["']?if["']?\s*:/);
    expect(stepText, "門ステップに continue-on-error が付いている").not.toMatch(
      /["']?continue-on-error["']?\s*:/,
    );
  });

  it("門ステップが呼ぶ scripts/run-publish-gates.mjs が実在する（パスの書き間違いで静かに空回りしない）", () => {
    expect(
      gateBlock,
      "門ステップが無いので、走らせる段の実在性そのものを確認できない",
    ).toBeDefined();
    expect(existsSync(runPublishGatesPath), `${runPublishGatesPath} が無い`).toBe(true);
  });
});
