import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `ci.yml` の `build` ジョブの `pnpm run api:check` の段が、**必ず走り、落ちたら job を落とす**こと（ADR 0178）。
 *
 * 既存の `ci-yml-api-check-wiring.test.mjs` は、段が在る・順序・`--write` を渡さない・二重配線が無いことを見ていた。
 * だが段に `|| true` を付ける・`continue-on-error: true` を付ける・`if:` で条件づける・`shell:` を差し替える・job ごと
 * `continue-on-error` にする、のどれでも、**段の行は `run: pnpm run api:check` のまま**で、その歯は緑だった
 * （Issue #1815 の確かめ直しで変異が素通りした）。同じ門を別の書き方で外す形である（#546 の門ステップの歯と同じ族）。
 *
 * ⚠ YAML は構造として解析していない（文字列で見ている。依存追加はオーナー専権）。キーを引用符で囲む書き方（`"if":`）と
 * フロー形式（`{ … }`）も落とさないよう、キー名の周りを広めに見る。
 *
 * **これはクローン（miku）の判断で足した歯で、オーナーの判断ではない**（ADR 0220）。
 */

const workflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);

function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

const jobLines = extractJob(workflow, "build");

/** `run: pnpm run api:check` を含む step（`      - name:` から次の `      - ` の直前まで）を返す。 */
function apiCheckStep(lines) {
  const runIdx = lines.findIndex((l) => /\brun:\s*pnpm run api:check\b/.test(l));
  expect(runIdx, "api:check の段が見つからない").toBeGreaterThan(-1);
  let start = runIdx;
  while (start > 0 && !/^ {6}- /.test(lines[start])) start -= 1;
  let end = lines.length;
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    if (/^ {6}- /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

const KEY = (name) => new RegExp(`(^|[\\s{,"'-])${name}["']?\\s*:`);

describe("ci.yml の api:check の段は、条件づけも握り潰しもされていない（ADR 0178）", () => {
  const step = apiCheckStep(jobLines);

  it("run の行は `pnpm run api:check` だけである（`|| true`・`; true`・`&&` などを足さない）", () => {
    const runLine = step.find((l) => /\brun:/.test(l));
    expect(runLine.trim()).toBe("run: pnpm run api:check");
  });

  it("段に `if:` が無い（条件づけて飛ばさない）", () => {
    expect(step.filter((l) => KEY("if").test(l))).toEqual([]);
  });

  it("段に `continue-on-error` が無い（落ちても job を通さない形にしない）", () => {
    expect(step.filter((l) => KEY("continue-on-error").test(l))).toEqual([]);
  });

  it("段に `shell:` が無い（既定の shell で走る。`bash {0}` などで `-e` を外さない）", () => {
    expect(step.filter((l) => KEY("shell").test(l))).toEqual([]);
  });

  it("段の `name:` が在る（どの段が落ちたかを job のログで名指しできる）", () => {
    expect(step.some((l) => KEY("name").test(l))).toBe(true);
  });
});

describe("ci.yml の build ジョブそのものが、条件づけも握り潰しもされていない", () => {
  // job の直下（4 空白）のキーだけを見る
  const jobKeys = jobLines.filter((l) => /^ {4}\S/.test(l));

  it("job に `if:` が無い", () => {
    expect(jobKeys.filter((l) => KEY("if").test(l))).toEqual([]);
  });

  it("job に `continue-on-error` が無い", () => {
    expect(jobKeys.filter((l) => KEY("continue-on-error").test(l))).toEqual([]);
  });

  it("job に `defaults:` の shell 指定が無い（`defaults.run.shell` で全段の shell を差し替えない）", () => {
    const block = jobLines.join("\n");
    expect(/\n {4}defaults:/.test(`\n${block}`)).toBe(false);
  });
});
