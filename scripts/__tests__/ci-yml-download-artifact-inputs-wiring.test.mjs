import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * 特定の1行（`if-no-artifact-found`）を禁止せず、`actions/download-artifact@v6` を使うすべての段の `with:` が、
 * v6 の宣言する入力の外へ出ていないことを検査する。他の action へは広げない（広げると主張が読めなくなる）。
 * YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

/**
 * v6 タグ時点の `action.yml` の `inputs:` を書き写した8個。`main` は v6 より後に `skip-decompress` / `digest-mismatch` を
 * 足しているが、`ci.yml` が固定しているのは v6 タグなので含めない。実行時には取得しない（ネットワークに出ない）。
 * `ci.yml` が別のタグへ上がったら取り直すこと。
 *
 * @type {ReadonlySet<string>}
 */
const V6_VALID_INPUT_NAMES = new Set([
  "name",
  "artifact-ids",
  "path",
  "pattern",
  "merge-multiple",
  "github-token",
  "repository",
  "run-id",
]);

const { text: blanked, unhandled } = blankOutWorkflowComments(workflow);

/**
 * 対象の同定に `with:` の値を使わない。値こそが変異の対象で、値で同定すると変異を当てた瞬間に段が対象外になり、歯が空回りする。
 *
 * @param {string} text コメント潰し済みの全文
 * @returns {string[]}
 */
function extractDownloadArtifactV6StepBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses:\s*actions\/download-artifact@v6\s*$/.test(lines[i])) {
      continue;
    }
    let start = i;
    while (start > 0 && !/^\s*- name:/.test(lines[start])) {
      start -= 1;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*- name:/.test(lines[j])) {
        end = j;
        break;
      }
    }
    blocks.push(lines.slice(start, end).join("\n"));
  }
  return blocks;
}

/**
 * @param {string} stepBlock
 * @returns {string[]}
 */
function extractWithKeys(stepBlock) {
  const lines = stepBlock.split("\n");
  const withAt = lines.findIndex((line) => /^(\s*)with:\s*$/.test(line));
  if (withAt === -1) {
    return [];
  }
  const withIndent = /^(\s*)with:\s*$/.exec(lines[withAt])[1].length;
  const childIndent = withIndent + 2;
  const keys = [];
  for (let i = withAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }
    const currentIndent = /^(\s*)/.exec(line)[1].length;
    if (currentIndent < childIndent) {
      break;
    }
    if (currentIndent !== childIndent) {
      continue;
    }
    const match = /^\s*([A-Za-z0-9_-]+):/.exec(line);
    if (match !== null) {
      keys.push(match[1]);
    }
  }
  return keys;
}

describe("ci.yml の actions/download-artifact@v6 の with: が、v6 の有効な入力の外へ出ていない(Issue #182)", () => {
  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(unhandled).toEqual([]);
  });

  it("対象の段が1件以上ある(空回り防止——0件ならこの歯は何も検査していない)", () => {
    const blocks = extractDownloadArtifactV6StepBlocks(blanked);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it("見つかった段すべての with: が、v6 の有効な入力名だけで構成されている", () => {
    const blocks = extractDownloadArtifactV6StepBlocks(blanked);
    const offenders = [];
    for (const block of blocks) {
      const keys = extractWithKeys(block);
      for (const key of keys) {
        if (!V6_VALID_INPUT_NAMES.has(key)) {
          offenders.push({ key, block });
        }
      }
    }
    expect(
      offenders,
      offenders
        .map(
          (offender) =>
            `無効な入力 '${offender.key}' を渡している段:\n${offender.block}\n` +
            `⟹ actions/download-artifact@v6 はこのキーを宣言していない。GitHub は` +
            "警告の注釈を出すだけでジョブを success のまま通すため、赤くならずに" +
            "見過ごされる(Issue #182)。",
        )
        .join("\n\n"),
    ).toEqual([]);
  });

  it("🔴 陰性対照: 検査関数そのものが、無効なキーを実際に検出できる(常に true を返すだけに退化していない)", () => {
    const syntheticOffendingBlock = [
      "      - name: 合成した段(この歯の検査そのものを確かめるためだけの架空の段)",
      "        uses: actions/download-artifact@v6",
      "        with:",
      "          pattern: lexical-regime-*",
      "          path: /tmp/somewhere",
      "          if-no-artifact-found: warn",
    ].join("\n");
    const keys = extractWithKeys(syntheticOffendingBlock);
    const offendingKeys = keys.filter((key) => !V6_VALID_INPUT_NAMES.has(key));
    expect(offendingKeys).toEqual(["if-no-artifact-found"]);

    const syntheticCleanBlock = syntheticOffendingBlock
      .split("\n")
      .filter((line) => !line.includes("if-no-artifact-found"))
      .join("\n");
    const cleanKeys = extractWithKeys(syntheticCleanBlock);
    expect(cleanKeys.every((key) => V6_VALID_INPUT_NAMES.has(key))).toBe(true);
  });

  it("extractDownloadArtifactV6StepBlocks が合成テキストからも段を正しく切り出す(取り出し方自体の確認)", () => {
    const synthetic = [
      "jobs:",
      "  synthetic-job:",
      "    steps:",
      "      - name: 何か関係ない段",
      "        run: echo hello",
      "",
      "      - name: 合成した download 段",
      "        uses: actions/download-artifact@v6",
      "        with:",
      "          name: something",
      "          bogus-input: oops",
      "",
      "      - name: 次の段(境界の確認)",
      "        run: echo done",
    ].join("\n");
    const blocks = extractDownloadArtifactV6StepBlocks(synthetic);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("合成した download 段");
    expect(blocks[0]).not.toContain("次の段");
    expect(extractWithKeys(blocks[0])).toEqual(["name", "bogus-input"]);
  });
});
