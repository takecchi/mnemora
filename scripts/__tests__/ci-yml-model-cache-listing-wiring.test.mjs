import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * - 「読むだけ・失敗させない」ステップが、末尾の `|| true` や `if: always()` を失うと、測るためのステップがジョブを落とす。それを文字列で見る。
 * - YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。`blankOutWorkflowComments` を通してから照合する。通さないと、地の文のコメントが引用しているだけで一致する。
 * - 一覧のステップの本数は固定せず、空回りを防ぐ下限だけを固定する。
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const { text: workflow, unhandled } = blankOutWorkflowComments(
  readFileSync(`${root}.github/workflows/ci.yml`, "utf8"),
);

/** @returns {string[]} トップレベルのジョブごとのブロック */
function jobBlocks(yaml) {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => line === "jobs:");
  if (jobsAt === -1) throw new Error("ci.yml に `jobs:` が無い。");
  const blocks = [];
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

/** @returns {string[]} ステップごとのブロック */
function steps(block) {
  const chunks = [];
  let current = null;
  for (const line of block.split("\n")) {
    if (/^ {6}- name: /.test(line)) {
      if (current) chunks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current.join("\n"));
  return chunks;
}

const LISTING_NAME = /- name: "復元した model キャッシュのファイルの一覧を出す/;
const listingSteps = jobBlocks(workflow).flatMap((b) =>
  steps(b).filter((s) => LISTING_NAME.test(s)),
);
const lastCommandLine = (step) =>
  step
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1);

describe("ci.yml: model キャッシュの一覧のステップは、読むだけで失敗させない", () => {
  it("コメント潰しが「扱えない」形に当たっていない", () => {
    expect(unhandled).toEqual([]);
  });

  it("一覧のステップが2つ以上見つかる（見つけ方が空回りしていない）", () => {
    expect(listingSteps.length).toBeGreaterThanOrEqual(2);
  });

  it("どのステップも if: always() で、cacheDir の一覧と既定のキャッシュ（--plain で引いた場所）の一覧を出す", () => {
    for (const step of listingSteps) {
      expect(step).toMatch(/^\s*if: always\(\)\s*$/m);
      expect(step).toContain(
        'DEFAULT_CACHE_DIR="$(node scripts/print-transformers-default-cache-dir.mjs --plain 2>/dev/null || true)"',
      );
      expect(step).toContain('find "${{ github.workspace }}/.cache/local-embedding"');
      expect(step).toContain('find "${DEFAULT_CACHE_DIR}"');
    }
  });

  it("どのステップも、find の行と、最後のコマンドが `|| true` で終わる（場所が空でも落ちない）", () => {
    for (const step of listingSteps) {
      const findLines = step.split("\n").filter((l) => l.includes("find "));
      expect(findLines.length).toBeGreaterThanOrEqual(2);
      for (const line of findLines) expect(line.trimEnd()).toMatch(/\|\| true$/);
      expect(lastCommandLine(step)).toMatch(/\|\| true$/);
    }
  });
});

describe("ci.yml: ネットワークに出さない読み込みの確かめは、測るだけで失敗させない", () => {
  const SCRIPT = "local-embedding-offline-load-check.ts";
  const holders = jobBlocks(workflow).flatMap((b) =>
    steps(b)
      .filter((s) => s.includes(SCRIPT))
      .map((s) => ({ job: b, step: s })),
  );

  it("ci.yml のちょうど1つのステップが呼び、スクリプトが実在する", () => {
    expect(holders).toHaveLength(1);
    expect(existsSync(`${root}examples/chat/src/scripts/${SCRIPT}`)).toBe(true);
  });

  it("`|| true` で終わり、examples/chat の作業ディレクトリで走る", () => {
    const run = holders[0].step.split("\n").find((l) => l.includes(SCRIPT));
    expect(run?.trimEnd()).toMatch(/\|\| true$/);
    expect(run).toContain("--filter @mnemora/example-chat");
  });

  it("同じジョブに、一覧のステップ（温めたキャッシュの復元の確認）もある", () => {
    expect(steps(holders[0].job).some((s) => LISTING_NAME.test(s))).toBe(true);
  });
});
