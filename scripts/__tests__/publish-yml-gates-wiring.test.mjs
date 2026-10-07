import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

// YAML は文字列で見る（依存を足さない）。run-publish-gates.mjs の名前は書き写さず yml から取り出す
// （書き写すと、改名で歯だけ古いまま緑になる）。

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));

const workflow = readFileSync(workflowPath, "utf8");

// 他ファイルの parseSteps と同形だが、共有しない（歯ごとに自己完結させる）。
/**
 * @param {string} yaml
 * @returns {{ name: string, run: string }[]}
 */
function parseSteps(yaml) {
  const steps = [];
  /** @type {string[] | null} */
  let current = null;
  for (const line of yaml.split("\n")) {
    if (/^ {6}- /.test(line)) {
      current = [line.replace(/^ {6}- /, "        ")];
      steps.push(current);
      continue;
    }
    if (!current) continue;
    if (line.trim() !== "" && /^ {0,7}\S/.test(line)) {
      current = null;
      continue;
    }
    current.push(line);
  }
  return steps.map((lines) => {
    const text = lines.join("\n");
    const nameMatch = text.match(/^ {8}name: (.*)$/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      run: parseScalarBlock(lines, "run"),
      raw: text,
    };
  });
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function parseScalarBlock(lines, key) {
  const body = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      const oneLine = line.match(new RegExp(`^ {8}${key}: (?!\\|)(.*)$`));
      if (oneLine) return oneLine[1].trim();
      if (new RegExp(`^ {8}${key}: \\|`).test(line)) {
        inside = true;
        continue;
      }
      continue;
    }
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (/^ {8}\S/.test(line)) break;
    body.push(line.replace(/^ {10}/, ""));
  }
  return body.join("\n").trim();
}

const steps = parseSteps(workflow);
const gateStep = steps.find((step) => step.run.includes("run-publish-gates.mjs"));

describe(".github/workflows/publish.yml が scripts/run-publish-gates.mjs に配線されていること（通しの歯）", () => {
  it("この歯は publish.yml を実際に読んでいる（読めなければ以下は何も測っていない）", () => {
    expect(workflow, `${workflowPath} が読めなかった`).not.toBe("");
    expect(steps.length, "publish.yml の steps を1段も切り出せなかった").toBeGreaterThan(5);
  });

  it("run-publish-gates.mjs を打つ段が在る（インラインの5行 + bash -e に戻っていない）", () => {
    expect(
      gateStep,
      "publish.yml に run-publish-gates.mjs を打つ段が無い" +
        "——門が5行のインライン pnpm run … に戻っている可能性がある（Issue #476 の欠陥が再発する）",
    ).toBeDefined();
  });

  it("段が打つスクリプトが実在する（パスの書き間違いで静かに空回りしない）", () => {
    expect(gateStep, "門ステップが無い").toBeDefined();
    const invocation = gateStep.run.match(/node\s+(\S*run-publish-gates\.mjs)/);
    expect(invocation, `node で起動していない: ${JSON.stringify(gateStep.run)}`).not.toBeNull();
    expect(existsSync(`${repoRoot}/${invocation[1]}`), `${invocation[1]} が無い`).toBe(true);
  });

  it("継続を握り潰す continue-on-error: を持たない", () => {
    expect(gateStep, "門ステップが無い").toBeDefined();
    expect(gateStep.raw).not.toMatch(/continue-on-error:\s*true/);
  });

  it("yml から取り出した呼び出しをそのまま実行すると、偽の段を前段の成否に関わらず全部起動し、失敗した段の名前を報告する", () => {
    expect(gateStep, "門ステップが無い").toBeDefined();
    const invocation = gateStep.run.match(/node\s+(\S*run-publish-gates\.mjs)/);
    expect(
      invocation,
      "門ステップが node で run-publish-gates.mjs を起動していない",
    ).not.toBeNull();

    const stages = [
      { name: "wired-stage-1", command: process.execPath, args: ["-e", "process.exit(0)"] },
      { name: "wired-stage-2", command: process.execPath, args: ["-e", "process.exit(9)"] },
      { name: "wired-stage-3", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ];
    const result = spawnSyncWithDeadline(process.execPath, [`${repoRoot}/${invocation[1]}`], {
      cwd: repoRoot,
      encoding: "utf8",
      // GITHUB_WORKFLOW を上書きする（publish の job の中で走ると、親の値が Publish になる）。
      env: {
        ...process.env,
        GITHUB_WORKFLOW: "test-of-publish-yml-gates-wiring",
        MNEMORA_PUBLISH_GATE_STAGES_JSON: JSON.stringify(stages),
      },
    });

    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).not.toBe(0);
    expect(result.stdout).toContain("wired-stage-3");
    expect(result.stdout).not.toContain("未起動");
    expect(result.stdout).toContain("失敗した段");
    expect(result.stdout).toContain("wired-stage-2");
  });
});
