import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。壊れたときは、配線が変わったのか書き方が変わったのかを見て、配線が変わっていないなら取り出し方を直す。
 * 実行系のテストは、summary 段の `--baseline` を一時ファイルへ差し替えて走らせる（`substituteBaselinePath`）。yml の本来のパスは文字列としてだけ固定し、ファイルの存在は要求しない。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "consolidation-cost";
const BASELINE_RELATIVE_PATH = "examples/chat/consolidation-baseline.json";

/**
 * @param {string} yaml
 * @param {string} jobId
 * @returns {string}
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。Issue #136 が足したジョブが消えたか、` +
        "名前が変わったか、インデントが変わった。",
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

/**
 * @param {string} jobBlock
 * @returns {Record<string, string>}
 */
function parseJobEnv(jobBlock) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => line === "    env:");
  if (start === -1) {
    return {};
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const matched = /^ {6}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
    if (!matched) {
      break;
    }
    env[matched[1]] = matched[2].trim();
  }
  return env;
}

/**
 * @param {string} jobBlock
 * @returns {{ name: string, env: Record<string, string>, run: string }[]}
 */
function parseSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error(`ci.yml の ${JOB_ID} ジョブに \`    steps:\` が無い`);
  }
  /** @type {{ name: string, env: Record<string, string>, run: string }[]} */
  const steps = [];
  /** @type {{ name: string, env: Record<string, string>, runLines: string[] } | undefined} */
  let current;
  let mode = "none";

  const flush = () => {
    if (current) {
      steps.push({
        name: current.name,
        env: current.env,
        run: current.runLines.map((l) => l.replace(/^ {10}/, "")).join("\n"),
      });
    }
  };

  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const nameMatched = /^ {6}- name: (.*)$/.exec(line);
    if (nameMatched) {
      flush();
      current = { name: nameMatched[1], env: {}, runLines: [] };
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
const jobEnv = parseJobEnv(jobBlock);
const steps = parseSteps(jobBlock);

const benchStep = steps.find((step) => step.env.MNEMORA_CONSOLIDATION_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("consolidation-cost-summary.mjs"));
const artifactStep = steps.find((step) => step.name.includes("成果物として残す"));

/** @type {{ stepName: string, unhandled: { lineNumber: number, reason: string, line: string }[] }[]} */
const stepBlockCommentUnhandled = [];

/**
 * 返す前にコメントを空白へ潰す。要約の段のコメントが実キーと同じ `if: always()` を引用しており、実キーを壊しても `toContain` が緑のまま通った。
 * 照合専用で、実行するテキストには適用しない（コメントを潰すと歯の意味が変わる）。
 *
 * @param {string} stepName
 * @returns {string | undefined}
 */
function extractStepBlock(stepName) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {6}- name:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const raw = lines.slice(start, end).join("\n");
  const { text, unhandled } = blankOutWorkflowComments(raw);
  if (unhandled.length > 0) {
    stepBlockCommentUnhandled.push({ stepName, unhandled });
  }
  return text;
}

/**
 * @param {string} text
 * @param {string} workspace
 * @returns {string}
 */
function substituteWorkspace(text, workspace) {
  const replaced = text.replaceAll("${{ github.workspace }}", workspace);
  if (replaced.includes("${{")) {
    throw new Error(
      `この歯が解釈できない GitHub Actions の式が残っている: ${replaced}。` +
        "式が増えたなら、この歯の置き換えのほうを足すこと(歯を消さないこと)。",
    );
  }
  return replaced;
}

/**
 * この歯はパスを自分では書かない。書き写すと、yml 側が変わったときに歯のほうが古いまま緑になる。
 *
 * @returns {string}
 */
function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の consolidation-cost ジョブに MNEMORA_CONSOLIDATION_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_CONSOLIDATION_JSON;
}

function summaryStepBaselinePath() {
  const matched = /--baseline\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
  return matched ? (matched[1] ?? matched[2]) : undefined;
}

/**
 * baseline のパスは、yml に書かれた実物ではなく一時ファイルへ差し替える。実行系のテストが実物の中身に依存しないようにする。
 *
 * @param {unknown} measured `--measured` が読むファイルに書き込む中身
 * @param {unknown} [baseline] `--baseline` が読むファイルに書き込む中身。省略時は
 *   `--baseline` の指定ごと script から取り除いて走らせる(measured のみのケース用)。
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(measured, baseline) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の consolidation-cost ジョブに consolidation-cost-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const realBaselineFlag = summaryStepBaselinePath();
  if (!realBaselineFlag) {
    throw new Error("summary の段に --baseline の指定が無い。");
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-consolidation-wiring-"));
  try {
    let script = substituteWorkspace(summaryStep.run, workspace);
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), workspace);
    writeFileSync(
      measuredPath,
      typeof measured === "string" ? measured : `${JSON.stringify(measured, null, 2)}\n`,
      "utf8",
    );
    if (baseline === undefined) {
      script = script.replace(/\s*--baseline\s+(?:"[^"]+"|[^\s\\]+)/, "");
    } else {
      const tempBaselinePath = join(workspace, "baseline.json");
      writeFileSync(
        tempBaselinePath,
        typeof baseline === "string" ? baseline : `${JSON.stringify(baseline, null, 2)}\n`,
        "utf8",
      );
      script = script.replace(realBaselineFlag, tempBaselinePath);
    }
    const summaryPath = join(workspace, "step-summary.md");
    writeFileSync(summaryPath, "", "utf8");
    const result = spawnSyncWithDeadline("bash", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    });
    return {
      status: result.status ?? -1,
      summary: readFileSync(summaryPath, "utf8"),
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "0".repeat(40),
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    probeCount: 1,
    haystackSize: 20,
    groupSize: 5,
    budgetLadder: [32],
    recallLimit: 50,
    stoppedAfterRound: 0,
    stopReason: "completed_all_rounds",
    rounds: [
      {
        round: 0,
        consolidation: null,
        store: {
          activeCount: 10,
          supersededCount: 0,
          activeContentChars: 500,
          activeContentTokens: 120,
          activeDigestChars: 200,
          activeDigestTokens: 60,
          allContentChars: 500,
        },
        recall: {
          unbudgeted: {
            probes: [
              {
                probeId: "color",
                carriedCount: 2,
                carriedDigestTokens: 10,
                usageChars: 100,
                usageEstimatedTokens: 40,
                usageIndexChars: 10,
                totalInScope: 20,
                goldRank: 1,
                recalledActiveShare: 0.2,
                omittedKinds: [],
                budgetExceeded: false,
              },
            ],
            mean: {
              carriedCount: 2,
              carriedDigestTokens: 10,
              usageChars: 100,
              usageEstimatedTokens: 40,
              usageIndexChars: 10,
              totalInScope: 20,
              recalledActiveShare: 0.2,
              goldRank: 1,
              goldRankExcludedCount: 0,
            },
          },
          budgeted: [],
        },
      },
    ],
    ...overrides,
  };
}

function makeBaseline(overrides = {}) {
  const measured = makeMeasured(overrides);
  return {
    ...measured,
    rounds: measured.rounds.map((round) => ({
      ...round,
      recall: {
        unbudgeted: { mean: round.recall.unbudgeted.mean },
        budgeted: round.recall.budgeted.map(({ probes: _probes, ...rung }) => rung),
      },
    })),
  };
}

describe("ci.yml の consolidation-cost ジョブの配線", () => {
  it("ジョブ自体が存在する(measure/summary/artifact の3段を持つ)", () => {
    expect(benchStep, "MNEMORA_CONSOLIDATION_JSON を渡す測定段が無い").toBeDefined();
    expect(summaryStep, "consolidation-cost-summary.mjs を打つ段が無い").toBeDefined();
    expect(artifactStep, "成果物を upload する段が無い").toBeDefined();
  });

  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("🔴 要約の段が --baseline を、マネージャーが用意する予定の基準値ファイルへ渡している", () => {
    expect(summaryStepBaselinePath(), "要約の段に --baseline の指定が無い").toBe(
      BASELINE_RELATIVE_PATH,
    );
  });

  it("DATABASE_URL が設定され、pgvector の service container を使っている", () => {
    expect(jobEnv.DATABASE_URL).toBeDefined();
    expect(jobBlock).toContain("pgvector/pgvector");
  });

  it("拡張作成(vector/btree_gin/pgcrypto)の段がある", () => {
    const extStep = steps.find((step) => step.run.includes("CREATE EXTENSION"));
    expect(extStep, "拡張作成の段が無い").toBeDefined();
    expect(extStep.run).toContain("vector");
    expect(extStep.run).toContain("btree_gin");
    expect(extStep.run).toContain("pgcrypto");
  });

  it("migrate の段がある", () => {
    const migrateStep = steps.find((step) => step.run.includes("run migrate"));
    expect(migrateStep, "migrate を実行する段が無い").toBeDefined();
  });

  it("測定の段が consolidation-cost サブコマンドを起動している", () => {
    expect(benchStep.run).toContain("run consolidation-cost");
  });

  it("🔴 基準値と相違しても緑のまま(⛔ このジョブは門ではない。ADR 0088 の判断を踏襲)", () => {
    const measured = makeMeasured();
    const baseline = makeBaseline();
    baseline.rounds[0].store.activeCount = 1;
    const result = runSummaryStepFromWorkflow(measured, baseline);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("相違した箇所がある");
    expect(result.summary).toContain("store.activeCount");
  });

  it("基準値と一致していれば、その旨が Job Summary に出る(1行で黙る)", () => {
    const measured = makeMeasured();
    const result = runSummaryStepFromWorkflow(measured, makeBaseline());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("一致(差分なし)。");
    expect(result.summary).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("🔴 実測 JSON が壊れていたら赤くなる(bench が壊れた=赤、数字が動いた=赤ではない)", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない", makeBaseline());
    expect(result.status).not.toBe(0);
  });

  it("weights_unavailable のときも要約の段は exit 0(if: always() の意図どおり)", () => {
    const result = runSummaryStepFromWorkflow(
      { status: "weights_unavailable", detail: "重みを取得できなかったので、値は測っていない: x" },
      makeBaseline(),
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).not.toContain("基準値との差分");
  });

  it("要約ステップに if: always() が付いている(measure が落ちても走る)", () => {
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("artifact ステップにも if: always() が付いている(measure が落ちても成果物は残す)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("実測値そのものを artifact として upload-artifact に渡している(bench の書き先と同じパス)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block).toContain("uses: actions/upload-artifact@v");
    expect(block).toContain(benchStepMeasuredPath());
  });

  it("ジョブに timeout-minutes が設定されている(既定 360 分で刺さらない)", () => {
    expect(jobBlock).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });
});

describe("コメント潰しが consolidation-cost ジョブの対象範囲で「扱えない」形に当たっていないこと(Issue #160)", () => {
  it("consolidation-cost ジョブの全段(name 段)に unhandled が無い", () => {
    stepBlockCommentUnhandled.length = 0;
    for (const step of steps) {
      extractStepBlock(step.name);
    }
    expect(stepBlockCommentUnhandled).toEqual([]);
  });
});
