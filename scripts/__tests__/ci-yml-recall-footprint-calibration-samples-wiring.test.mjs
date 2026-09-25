import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` の `example-chat` ジョブが、実際に
 * `recall-footprint-calibration-samples` サブコマンドを実行し、その出力を
 * `scripts/recall-footprint-calibration-samples-summary.mjs` へ渡し、artifact として
 * アップロードしていること（Issue #340 フォローアップ、ADR 0313）。**
 *
 * ⚠ **これは `recall-footprint-calibration-samples-summary.test.mjs`/`-lib.test.mjs`
 * の重複ではない**（`ci-yml-compare-wiring.test.mjs` の docstring と同じ理由）。
 * その2本は**入力を自分で作って**要約の中身と exit code を測る——どちらも `ci.yml` を
 * 1バイトも読まない。この歯だけが `ci.yml` を入力に取る。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**`ci-yml-compare-wiring
 * .test.mjs` と同じ判断——歯のために YAML パーサの依存を足していない（依存追加は
 * オーナー専権）。壊れたときは「配線が変わった」か「書き方が変わった」かを見て、
 * 配線が変わっていないなら取り出し方のほうを直すこと（歯を消さないこと）。
 *
 * 🔴 **`--baseline` は `examples/chat/recall-footprint-calibration-samples-baseline.json` へ渡っている**
 * （基準値ファイルは PR #728 の CI artifact で2回一致を経て作った。ADR 0313）。
 * 以前この歯は「まだ渡していない」ことを固定していた。基準値ファイルができたので、
 * `ci-yml-time-term-wiring.test.mjs` が ADR 0121 決定5 で辿った道と同じように、
 * 「実在する基準値ファイルへ配線されている」ことを固定する歯へ置き換えた。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "example-chat";

/** `jobs:` の下の1ジョブを切り出す（他の `ci-yml-*-wiring.test.mjs` と同じ形）。 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い。`);
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

/** `steps:` を段へ切り分け、各段の `name`/`env`/`run` だけを取り出す。 */
function parseSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error(`ci.yml の ${JOB_ID} ジョブに \`    steps:\` が無い`);
  }
  const steps = [];
  let current;
  let mode = "none";

  const flush = () => {
    if (current) {
      steps.push({
        name: current.name,
        env: current.env,
        run: current.runLines.map((l) => l.replace(/^ {10}/, "")).join("\n"),
        withBlock: current.withLines.join("\n"),
      });
    }
  };

  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const nameMatched = /^ {6}- name: (.*)$/.exec(line);
    if (nameMatched) {
      flush();
      current = { name: nameMatched[1], env: {}, runLines: [], withLines: [] };
      mode = "none";
      continue;
    }
    if (!current) {
      continue;
    }
    if (line === "        env:") {
      mode = "env";
      continue;
    }
    if (line === "        with:") {
      mode = "with";
      continue;
    }
    if (/^ {8}run: \|/.test(line)) {
      mode = "run";
      continue;
    }
    const inlineRun = /^ {8}run: (.+)$/.exec(line);
    if (inlineRun) {
      current.runLines.push(`          ${inlineRun[1]}`);
      mode = "none";
      continue;
    }
    if (mode === "env") {
      const envMatched = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (envMatched) {
        current.env[envMatched[1]] = envMatched[2].trim();
        continue;
      }
      mode = "none";
    }
    if (mode === "with") {
      if (/^ {10}/.test(line)) {
        current.withLines.push(line.replace(/^ {10}/, ""));
        continue;
      }
      mode = "none";
    }
    if (mode === "run") {
      if (line.trim() === "" || /^ {10}/.test(line)) {
        current.runLines.push(line);
        continue;
      }
      mode = "none";
    }
  }
  flush();
  return steps;
}

const jobBlock = extractJob(workflow, JOB_ID);
const steps = parseSteps(jobBlock);

const ENV_KEY = "MNEMORA_RECALL_FOOTPRINT_CALIBRATION_SAMPLES_JSON";
const benchStep = steps.find((step) => step.env[ENV_KEY] !== undefined);
const summaryStep = steps.find((step) =>
  step.run.includes("recall-footprint-calibration-samples-summary.mjs"),
);
const artifactStep = steps.find(
  (step) =>
    step.withBlock.includes("name: recall-footprint-calibration-samples") &&
    !step.name.includes("compare"),
);

function substituteWorkspace(text, workspace) {
  const replaced = text.replaceAll("${{ github.workspace }}", workspace);
  if (replaced.includes("${{")) {
    throw new Error(
      `この歯が解釈できない GitHub Actions の式が残っている: ${replaced}。` +
        "式が増えたなら、この歯の置き換えのほうを足すこと（歯を消さないこと）。",
    );
  }
  return replaced;
}

function benchStepJsonPath() {
  if (!benchStep) {
    throw new Error(
      `ci.yml の example-chat ジョブに ${ENV_KEY} を渡す段が無い。` +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env[ENV_KEY];
}

function summaryStepMeasuredPath() {
  const matched = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
  return matched ? (matched[1] ?? matched[2]) : undefined;
}

describe("ci.yml の example-chat ジョブの recall-footprint-calibration-samples 配線", () => {
  it("recall-footprint-calibration-samples サブコマンドを実行する段が在る", () => {
    expect(
      benchStep,
      "MNEMORA_RECALL_FOOTPRINT_CALIBRATION_SAMPLES_JSON を渡す段が無い",
    ).toBeDefined();
    expect(benchStep?.run).toContain("run recall-footprint-calibration-samples");
  });

  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    expect(
      summaryStep,
      "要約の段(recall-footprint-calibration-samples-summary.mjs)が無い",
    ).toBeDefined();
    expect(summaryStepMeasuredPath()).toBe(benchStepJsonPath());
  });

  it("--baseline が、実在する較正標本の基準値ファイルへ配線されている(ADR 0313)", () => {
    const matched = /--baseline\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    const baselinePath = matched?.[1] ?? matched?.[2];
    expect(baselinePath).toBe("examples/chat/recall-footprint-calibration-samples-baseline.json");
    const baselineJson = JSON.parse(readFileSync(join(repoRoot, baselinePath), "utf8"));
    expect(baselineJson.rowCount).toBe(baselineJson.rows.length);
  });

  it("artifact アップロード段が、bench の書き先と同じ path を指している", () => {
    expect(
      artifactStep,
      "recall-footprint-calibration-samples の artifact アップロード段が無い",
    ).toBeDefined();
    expect(artifactStep?.withBlock).toContain(benchStepJsonPath());
  });

  it("実際に summary の段を(本物の JSON に対して)走らせると exit 0 になる", () => {
    const workspace = mkdtempSync(join(tmpdir(), "mnemora-rfcs-wiring-"));
    try {
      const script = substituteWorkspace(summaryStep.run, workspace);
      const measuredPath = substituteWorkspace(benchStepJsonPath(), workspace);
      const measured = {
        schemaVersion: 1,
        measuredAt: "2026-09-25T00:00:00.000Z",
        commit: "0".repeat(40),
        llmMode: "recorded",
        embeddingMode: "recorded",
        designDecidedBeforeSeeingHoldOutErrors: true,
        rowCount: 1,
        rows: [
          {
            fillerPairs: 12,
            recallLimit: 20,
            turnCount: 26,
            totalInScope: 9,
            returnedCount: 9,
            mnemoraChars: 300,
            bandEntryCount: 0,
            rawIndex: { totalInScope: 9, groups: [], countKind: "exact" },
            rawIndexJsonLength: 40,
          },
        ],
      };
      writeFileSync(measuredPath, JSON.stringify(measured, null, 2), "utf8");
      const summaryPath = join(workspace, "step-summary.md");
      writeFileSync(summaryPath, "", "utf8");
      const result = spawnSync("bash", ["-c", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(summaryPath, "utf8")).toContain("fillerPairs");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
