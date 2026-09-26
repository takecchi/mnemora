import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの**（ADR 0345）
 *
 * **`.github/workflows/ci.yml` の `build` ジョブが、`pnpm run check:doc-snippets`
 * （`scripts/check-doc-snippets.mjs`）を `Build` ステップより後で走らせていること。**
 *
 * `check-doc-snippets-lib.test.mjs` は部品を合成の入力で確かめるだけで、`ci.yml` を読まない。
 * ⟹ 誰かがこの段を落としても、`Build` より前へ動かしても（`dist` が無くて全部の片が
 * 解決できずに落ちる）、別ジョブへ切り出しても（required status check の文脈名とずれる）、
 * そちらは緑のまま通る。
 *
 * ⚠ YAML は構造として解析していない（`ci-yml-api-check-wiring.test.mjs` と同じ判断）。
 */

const workflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
);

function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い。`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const jobBlock = extractJob(workflow, "build");

describe("ci.yml の build ジョブの check:doc-snippets 配線（ADR 0345）", () => {
  it("package.json の check:doc-snippets が scripts/check-doc-snippets.mjs を指す", () => {
    expect(packageJson.scripts["check:doc-snippets"]).toBe("node scripts/check-doc-snippets.mjs");
  });

  it("build ジョブに `pnpm run check:doc-snippets` を打つ段がある", () => {
    expect(jobBlock).toContain("run: pnpm run check:doc-snippets");
  });

  it("🔴 その段は Build ステップより後にある（dist の .d.ts に当てるため）", () => {
    const buildIdx = jobBlock.indexOf("- name: Build\n");
    const stepIdx = jobBlock.indexOf("run: pnpm run check:doc-snippets");
    expect(buildIdx, "Build ステップが見つからない").toBeGreaterThan(-1);
    expect(stepIdx).toBeGreaterThan(buildIdx);
  });

  it("🔴 別ジョブではなく、既存の build ジョブへの追加である（required status check の文脈名を変えない）", () => {
    expect(jobBlock).toContain("name: typecheck / lint / test / build");
  });
});
