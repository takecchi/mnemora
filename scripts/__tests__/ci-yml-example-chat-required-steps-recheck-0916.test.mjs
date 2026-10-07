import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。キーを引用符で囲む書き方（`"if":`）とフロー形式（`{ … }`）も落とさないよう、キー名の周りを広めに見る。
 * 段の `shell:` は `bash {0}` のような無害な値も含めて禁じる。値の良し悪しを文字列で判定すると、`bash -c "{0}; true"` のような握り潰しを見逃す。
 * job の `continue-on-error`・`if` は、`ci-yml-local-embedding-fingerprint-wiring` が example-chat ジョブについて既に見ているので重ねない。
 */

const workflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);
const chatPackageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../examples/chat/package.json", import.meta.url)), "utf8"),
);
const chatVitestConfig = readFileSync(
  fileURLToPath(new URL("../../examples/chat/vitest.config.mts", import.meta.url)),
  "utf8",
);

const KEY = (name) => new RegExp(`(^|[\\s{,"'-])${name}["']?\\s*:`);

function withoutComments(lines) {
  return lines.filter((line) => !/^\s*#/.test(line));
}

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

function stepsRunning(jobLines, command) {
  const runLine = `        run: ${command}`;
  const starts = [];
  jobLines.forEach((line, i) => {
    if (line === runLine) starts.push(i);
  });
  return starts.map((runIdx) => {
    let start = runIdx;
    while (start > 0 && !/^ {6}- /.test(jobLines[start])) start -= 1;
    let end = jobLines.length;
    for (let i = runIdx + 1; i < jobLines.length; i += 1) {
      if (/^ {6}- /.test(jobLines[i])) {
        end = i;
        break;
      }
    }
    return withoutComments(jobLines.slice(start, end));
  });
}

const jobLines = extractJob(workflow, "example-chat");

const REQUIRED_STEPS = [
  {
    label: "correction サブコマンドの段",
    command: "pnpm --filter @mnemora/example-chat run correction",
  },
  {
    label: "examples/chat の試験（test:db）の段",
    command: "pnpm --filter @mnemora/example-chat run test:db",
  },
];

describe.each(REQUIRED_STEPS)(
  "ci.yml の example-chat ジョブの $label は、落ちたら job を落とす",
  ({ command }) => {
    const found = stepsRunning(jobLines, command);

    it("`run` が `pnpm … run …` の1行だけの段が、ちょうど1つ在る（`|| true`・`; true` を足さず、消さず、重ねない）", () => {
      expect(found).toHaveLength(1);
      const runLines = found[0].filter((line) => /\brun:/.test(line));
      expect(runLines.map((line) => line.trim())).toEqual([`run: ${command}`]);
    });

    it("段に `if:` が無い（条件づけて飛ばさない。常に走る `if: always()` だけは許す）", () => {
      const conditions = found[0].filter(
        (line) => KEY("if").test(line) && !/^\s*if:\s*always\(\)\s*$/.test(line),
      );
      expect(conditions).toEqual([]);
    });

    it("段に `continue-on-error` が無い", () => {
      expect(found[0].filter((line) => KEY("continue-on-error").test(line))).toEqual([]);
    });

    it("段に `shell:` が無い（既定の shell で走る）", () => {
      expect(found[0].filter((line) => KEY("shell").test(line))).toEqual([]);
    });
  },
);

describe("example-chat ジョブ・ワークフローは、全段の shell を差し替えない", () => {
  it("ジョブに `defaults:` が無い（`defaults.run.shell` で全段の shell を差し替えない）", () => {
    const jobKeys = withoutComments(jobLines).filter((line) => /^ {4}\S/.test(line));
    expect(jobKeys.filter((line) => KEY("defaults").test(line))).toEqual([]);
  });

  it("ワークフロー直下に `defaults:` が無い", () => {
    const topLevel = withoutComments(workflow.split("\n")).filter((line) => /^\S/.test(line));
    expect(topLevel.filter((line) => KEY("defaults").test(line))).toEqual([]);
  });
});

describe("段が呼ぶ package.json の script は、失敗を握り潰さず、試験を絞らない", () => {
  it("`correction` は cli.ts の correction を呼ぶだけである", () => {
    expect(chatPackageJson.scripts.correction).toBe("tsx src/cli.ts correction");
  });

  it("`test:db` は `vitest run` だけである（`|| true`・`--exclude`・ファイル指定・`--passWithNoTests` を足さない）", () => {
    expect(chatPackageJson.scripts["test:db"]).toBe("vitest run");
  });

  it("vitest の設定が試験ファイルを除外しない（`exclude`・`include` を持たない）", () => {
    const keys = withoutComments(chatVitestConfig.split("\n"));
    expect(keys.filter((line) => KEY("exclude").test(line))).toEqual([]);
    expect(keys.filter((line) => KEY("include").test(line))).toEqual([]);
  });
});
