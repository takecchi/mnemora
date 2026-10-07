import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideDryRun } from "../publish-dry-run.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

// YAML は構造解析せず文字列で見る（歯のために依存を足さない）。壊れたら、配線が変わったのか
// 書き方が変わったのかを見て、配線が同じなら取り出し方のほうを直す。

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));

const workflow = readFileSync(workflowPath, "utf8");

/**
 * @param {string} yaml
 * @returns {{ name: string, id: string | undefined, env: Record<string, string>, run: string }[]}
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
    const idMatch = text.match(/^ {8}id: (\S+)/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      id: idMatch ? idMatch[1] : undefined,
      env: parseBlock(lines, "env"),
      run: parseScalarBlock(lines, "run"),
    };
  });
}

/**
 * @param {string[]} lines
 * @returns {Record<string, string>}
 */
function parseBlock(lines, key) {
  /** @type {Record<string, string>} */
  const out = {};
  let inside = false;
  for (const line of lines) {
    if (new RegExp(`^ {8}${key}:\\s*$`).test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line.trim() === "") continue;
    if (/^ {8}\S/.test(line)) break;
    const match = line.match(/^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
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

const decisionStep = steps.find((step) => step.run.includes("decide-publish-dry-run.mjs"));
const publishStep = steps.find((step) => step.run.includes("npm publish"));

describe(".github/workflows/publish.yml が decideDryRun() に配線されていること（通しの歯）", () => {
  it("この歯は publish.yml を実際に読んでいる（読めなければ以下は何も測っていない）", () => {
    expect(workflow, `${workflowPath} が読めなかった`).not.toBe("");
    expect(steps.length, "publish.yml の steps を1段も切り出せなかった").toBeGreaterThan(5);
  });

  it("判定を scripts/decide-publish-dry-run.mjs に委ねる段が在る（インライン判定に戻っていない）", () => {
    expect(
      decisionStep,
      "publish.yml に decide-publish-dry-run.mjs を打つ段が無い" +
        "——判定が workflow 内の shell に戻っている可能性がある（ADR 0067 の fail-open が再発する）",
    ).toBeDefined();
    expect(decisionStep.id, "判定の段に id: が無いと、下の段が出力を受け取れない").toBeDefined();
  });

  it("判定の段が打つスクリプトが実在する（パスの書き間違いで静かに落ちない）", () => {
    expect(
      decisionStep,
      "判定の段が無い——判定が workflow 内の shell に戻っている（ADR 0067 の fail-open が再発する）",
    ).toBeDefined();
    const invocation = decisionStep.run.match(/node\s+(\S*decide-publish-dry-run\.mjs)/);
    expect(invocation, `node で起動していない: ${JSON.stringify(decisionStep.run)}`).not.toBeNull();
    expect(existsSync(join(repoRoot, invocation[1])), `${invocation[1]} が無い`).toBe(true);
  });

  it("判定の段は event_name と dry_run を env: 経由で渡す（${{ }} の直接展開に戻っていない）", () => {
    expect(
      decisionStep,
      "判定の段が無い——判定が workflow 内の shell に戻っている（ADR 0067 の fail-open が再発する）",
    ).toBeDefined();
    const values = Object.values(decisionStep.env);
    expect(
      values.some((v) => v.includes("github.event_name")),
      "github.event_name を渡す env: が無い",
    ).toBe(true);
    expect(
      values.some((v) => v.includes("inputs.dry_run")),
      "inputs.dry_run を渡す env: が無い",
    ).toBe(true);
  });
});

// env 名やコマンドは yml から読み取る。書き写すと、yml 側の改名で歯だけ古いまま緑になる。
function readInvocationFromWorkflow() {
  // 配線が消えると decisionStep は undefined になる。素の TypeError にせず、名指しで落とす。
  expect(
    decisionStep,
    "publish.yml に decide-publish-dry-run.mjs を打つ段が無い" +
      "——判定が workflow 内の shell に戻っている（ADR 0067 の fail-open が再発する）",
  ).toBeDefined();
  const invocation = decisionStep.run.match(/node\s+(\S*decide-publish-dry-run\.mjs)/);
  expect(
    invocation,
    "判定の段が node で decide-publish-dry-run.mjs を起動していない",
  ).not.toBeNull();
  const entries = Object.entries(decisionStep.env);
  const eventKey = entries.find(([, v]) => v.includes("github.event_name"))?.[0];
  const dryRunKey = entries.find(([, v]) => v.includes("inputs.dry_run"))?.[0];
  expect(eventKey, "判定の段が github.event_name を env: で渡していない").toBeDefined();
  expect(dryRunKey, "判定の段が inputs.dry_run を env: で渡していない").toBeDefined();
  return { command: invocation[1], eventKey, dryRunKey };
}

describe("publish.yml の判定が decideDryRun() と同じ答えを出す（同じ入力集合で突き合わせる）", () => {
  const eventNames = ["release", "workflow_dispatch", "push", ""];
  const dryRunInputs = ["true", "false", "", undefined, "TRUE", "True", "1", "yes", "null"];

  function runAsWorkflowWould({ eventName, dryRunInput }) {
    const { command, eventKey, dryRunKey } = readInvocationFromWorkflow();
    const workDir = mkdtempSync(join(tmpdir(), "publish-yml-wiring-"));
    try {
      const githubOutput = join(workDir, "github_output");
      writeFileSync(githubOutput, "");
      const env = { ...process.env, GITHUB_OUTPUT: githubOutput };
      delete env.EVENT_NAME;
      delete env.DRY_RUN_INPUT;
      env[eventKey] = eventName;
      if (dryRunInput !== undefined) env[dryRunKey] = dryRunInput;
      const result = spawnSyncWithDeadline(process.execPath, [join(repoRoot, command)], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
      });
      const written = readFileSync(githubOutput, "utf8");
      const match = written.match(/^dry_run=(true|false)$/m);
      return {
        status: result.status,
        stdout: result.stdout,
        dryRun: match ? match[1] === "true" : undefined,
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  for (const eventName of eventNames) {
    for (const dryRunInput of dryRunInputs) {
      const label = `event_name=${JSON.stringify(eventName)} dry_run=${JSON.stringify(dryRunInput)}`;
      it(`一致する: ${label}`, () => {
        const expected = decideDryRun({ eventName, dryRunInput });
        const actual = runAsWorkflowWould({ eventName, dryRunInput });
        expect(actual.status, `${label} で判定の段が 0 以外で終了した`).toBe(0);
        expect(
          actual.dryRun,
          `${label}: publish.yml の配線が出した答えと decideDryRun() の答えが食い違う`,
        ).toBe(expected.dryRun);
      });
    }
  }
});

describe("判定の答えが npm publish の段まで届いている（出力名と shell 分岐）", () => {
  it("npm publish の段が、判定の段の outputs.dry_run を env: で受けている", () => {
    expect(publishStep, "npm publish を打つ段が見つからない").toBeDefined();
    expect(decisionStep, "判定の段が無いので、受け取る出力そのものが存在しない").toBeDefined();
    const consumed = Object.entries(publishStep.env).find(([, v]) =>
      new RegExp(`steps\\.${decisionStep.id}\\.outputs\\.dry_run`).test(v),
    );
    expect(
      consumed,
      `npm publish の段が steps.${decisionStep.id}.outputs.dry_run を受けていない` +
        "——判定は走るが、その答えが publish に届いていない",
    ).toBeDefined();
  });

  it("受け取った dry_run が true のときだけ --dry-run が立つ（yml の shell を実際に走らせる）", () => {
    expect(decisionStep, "判定の段が無いので、受け取る出力そのものが存在しない").toBeDefined();
    const consumed = Object.entries(publishStep.env).find(([, v]) =>
      new RegExp(`steps\\.${decisionStep.id}\\.outputs\\.dry_run`).test(v),
    );
    expect(consumed, "npm publish の段が判定の段の outputs.dry_run を受けていない").toBeDefined();
    const consumedKey = consumed[0];
    const branch = publishStep.run.match(/(^|\n)( *)(\w+)=""\n[\s\S]*?\n\2fi/);
    expect(branch, "npm publish の段から --dry-run を立てる分岐を取り出せなかった").not.toBeNull();
    const flagVar = branch[3];
    const segment = branch[0];
    expect(segment, "取り出した分岐が --dry-run を立てていない").toContain("--dry-run");

    for (const [given, want] of [
      ["true", "--dry-run"],
      ["false", ""],
      ["", ""],
    ]) {
      const result = spawnSyncWithDeadline(
        "bash",
        ["-c", `set -u\n{\n${segment}\n} > /dev/null\nprintf '%s' "\${${flagVar}}"`],
        { encoding: "utf8", env: { ...process.env, [consumedKey]: given } },
      );
      expect(result.status, `${consumedKey}=${JSON.stringify(given)} で shell が落ちた`).toBe(0);
      expect(result.stdout, `${consumedKey}=${JSON.stringify(given)} のときの flag`).toBe(want);
    }
  });

  it("立てた flag が npm publish の行へ渡っている", () => {
    const branch = publishStep.run.match(/(^|\n)( *)(\w+)=""\n[\s\S]*?\n\2fi/);
    const flagVar = branch[3];
    expect(publishStep.run).toMatch(new RegExp(`npm publish[\\s\\S]{0,300}\\$\\{${flagVar}\\}`));
  });
});
