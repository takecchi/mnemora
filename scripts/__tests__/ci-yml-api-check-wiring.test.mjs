import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。壊れたときは、配線が変わったのか書き方が変わったのかを見て、配線が変わっていないなら取り出し方を直す。 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const JOB_ID = "build";

function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。build ジョブが消えたか名前が変わった。`,
    );
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

const jobBlock = extractJob(workflow, JOB_ID);

describe("ci.yml の build ジョブの api:check 配線（Issue #342 / ADR 0178）", () => {
  it("build ジョブに `pnpm run api:check` を打つ段がある", () => {
    expect(jobBlock).toContain("run: pnpm run api:check");
  });

  it("🔴 api:check の段は Build ステップの直後にある（dist が既に在ることに依存するため、順序を崩せない）", () => {
    const buildIdx = jobBlock.indexOf("- name: Build\n");
    const apiIdx = jobBlock.indexOf("run: pnpm run api:check");
    const cjsIdx = jobBlock.indexOf("run: pnpm run check:cjs-parse");
    const packIdx = jobBlock.indexOf("run: pnpm run pack:check");
    expect(buildIdx, "Build ステップが見つからない").toBeGreaterThan(-1);
    expect(apiIdx, "api:check の段が見つからない").toBeGreaterThan(-1);
    expect(apiIdx).toBeGreaterThan(buildIdx);
    expect(apiIdx).toBeLessThan(cjsIdx);
    expect(cjsIdx).toBeLessThan(packIdx);
  });

  it("api:check の段は --write を渡さない（CI は判定するだけで snapshot を書き換えない）", () => {
    const apiIdx = jobBlock.indexOf("run: pnpm run api:check");
    const nextStepIdx = jobBlock.indexOf("\n      - name:", apiIdx);
    const stepBlock = jobBlock.slice(apiIdx, nextStepIdx === -1 ? undefined : nextStepIdx);
    expect(stepBlock).not.toContain("--write");
  });

  it("🔴 このジョブが7つ目の別ジョブではなく、既存の build ジョブへの追加である（branch protection の対象名を変えない。ADR 0138 と同じ論拠）", () => {
    expect(jobBlock).toContain("name: typecheck / lint / test / build");
  });

  it("api:check を打つのはこのジョブだけである（他ジョブへの誤配線・二重配線が無い）", () => {
    const occurrences = [...workflow.matchAll(/run: pnpm run api:check/g)];
    expect(occurrences).toHaveLength(1);
  });

  it("🔴 package.json の scripts.api:check は --write を渡さない CLI を指す（CI が呼ぶのはこちら）", () => {
    expect(packageJson.scripts["api:check"]).toBe("node scripts/check-public-api-surface.mjs");
  });

  it("🔴 package.json の scripts.api:write は --write を渡す CLI を指す（`format`/`format:check` と同じ対）", () => {
    expect(packageJson.scripts["api:write"]).toBe(
      "node scripts/check-public-api-surface.mjs --write",
    );
  });
});
