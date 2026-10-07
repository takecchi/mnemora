import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateBaseline, validateMeasured } from "../identifier-probe-summary-lib.mjs";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/** YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。壊れたときは、配線が変わったのか書き方が変わったのかを見て、配線が変わっていないなら取り出し方を直す。 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "identifier-probes";

/**
 * @param {string} yaml
 * @param {string} jobId
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。` +
        "Issue #109 が足したジョブが消えたか、名前が変わったか、インデントが変わった。",
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
const steps = parseSteps(jobBlock);

const benchStep = steps.find((step) => step.env.MNEMORA_IDENTIFIER_PROBE_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("identifier-probe-summary.mjs"));
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
 * ただの `toContain("if: always()")` にせず、`if:` キーの行として現れているかを正規表現に切り出す。
 * 素朴な部分文字列一致では、実キーを壊す変異と、ふるまいを変えないコメントの書き換えを区別する歯を書けない。
 *
 * @param {string} blankedBlock コメントを潰した段の生テキスト（`extractStepBlock` の返り値）
 * @returns {boolean}
 */
function blockDeclaresAlways(blankedBlock) {
  return /^\s*if:\s*always\(\)\s*$/m.test(blankedBlock);
}

/**
 * @param {string} text
 * @param {string} workspace
 */
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

/** この歯はパスを自分では書かない。書き写すと、yml 側が変わったときに歯のほうが古いまま緑になる。 */
function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の identifier-probes ジョブに MNEMORA_IDENTIFIER_PROBE_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_IDENTIFIER_PROBE_JSON;
}

function summaryStepBaselinePath() {
  const matched = /--baseline\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
  return matched ? (matched[1] ?? matched[2]) : undefined;
}

/**
 * @param {unknown} measured `--measured` が読むファイルに書き込む中身
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(measured) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の identifier-probes ジョブに identifier-probe-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-idp-wiring-"));
  try {
    const script = substituteWorkspace(summaryStep.run, workspace);
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), workspace);
    writeFileSync(
      measuredPath,
      typeof measured === "string" ? measured : `${JSON.stringify(measured, null, 2)}\n`,
      "utf8",
    );
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

const baselineRelativePath = "examples/chat/identifier-probe-baseline.json";
const baseline = JSON.parse(readFileSync(join(repoRoot, baselineRelativePath), "utf8"));

function measuredFromBaseline() {
  const byGroup = Object.fromEntries(
    baseline.groups.map((group) => {
      const copy = structuredClone(group);
      delete copy.group;
      delete copy.description;
      return [group.group, copy];
    }),
  );
  return {
    schemaVersion: 2,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "0".repeat(40),
    ...byGroup,
  };
}

describe("ci.yml の identifier-probes ジョブの配線", () => {
  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    // `${{ github.workspace }}` は中に空白を含みうるので、空白で切らない。
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("🔴 要約の段が --baseline をコミット済みの基準値ファイルへ渡している（ADR 0094 §8）", () => {
    expect(summaryStepBaselinePath(), "要約の段に --baseline の指定が無い").toBe(
      baselineRelativePath,
    );
  });

  it("🔴 --baseline が指すファイルが、実際に validateBaseline を通る", () => {
    const result = validateBaseline(baseline);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("🔴 基準値から組み立てた実測 JSON が validateMeasured を通る（2つの形が食い違っていない）", () => {
    const result = validateMeasured(measuredFromBaseline());
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("⭐ 各群の label が、その群自身の条件（llm・provider/model/dimensions・haystack）を落としていない", () => {
    for (const group of baseline.groups) {
      expect(group.label, `${group.group} の label`).toContain(`llm=${group.llmMode}`);
      expect(group.label, `${group.group} の label`).toContain(group.embeddingSpace.provider);
      expect(group.label, `${group.group} の label`).toContain(group.embeddingSpace.model);
      expect(group.label, `${group.group} の label`).toContain(
        `${group.embeddingSpace.dimensions}次元`,
      );
      expect(group.label, `${group.group} の label`).toContain(`haystack=${group.haystackKind}`);
    }
  });

  it("🔴 基準値と相違しても緑のまま（⛔ このジョブは門ではない。標本が小さい。ADR 0033 §3）", () => {
    const measured = measuredFromBaseline();
    // 想起の質が大きく劣化しても落ちない。probe 7件の標本で偽陽性を出す門にしない。
    measured.japanese.hit1Count = 1;
    measured.japanese.mrrOverall = 0.2;
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("0.200");
    expect(result.summary).toContain("### japanese");
    expect(result.summary).toContain("hit1Count");
  });

  it("🔴 embeddingSpace だけが動いた（数字は同じ）ときも、Job Summary が相違として出す", () => {
    const measured = measuredFromBaseline();
    measured.identifiersDense.embeddingSpace.model = "text-embedding-3-small";
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("### identifiersDense");
    expect(result.summary).toContain("embeddingSpace.model");
  });

  it("基準値と一致していれば、その旨が Job Summary に出る（1行で黙る）", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("一致（差分なし）");
    expect(result.summary).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("🔴 weights_unavailable のときは、Job Summary に比較が1つも出ない（緑のまま）", () => {
    const result = runSummaryStepFromWorkflow({
      schemaVersion: 2,
      status: "weights_unavailable",
      measuredAt: "2026-09-10T00:00:00.000Z",
      commit: "0".repeat(40),
      detail: "HTTP 503 from the model host",
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("重みを取得できなかったので、値は測っていない");
    expect(result.summary).not.toContain("基準値との差分");
    expect(result.summary).not.toContain("一致");
    expect(result.summary).not.toContain("相違");
    expect(result.summary).not.toContain("MRR");
  });

  it("🔴 実測 JSON が壊れていたら赤くなる（bench が壊れた＝赤、数字が動いた＝赤ではない）", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });

  it("要約の中身が Job Summary へ届いている（群と条件と数字が同じ行に並ぶ）", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    const dense = baseline.groups.find((group) => group.group === "identifiersDense");
    const row = result.summary
      .split("\n")
      .find((line) => line.includes(dense.label) && line.includes("|"));
    expect(row, "identifiersDense の行が Job Summary に無い").toBeDefined();
    expect(row).toContain(dense.llmMode);
    expect(row).toContain(dense.embeddingSpace.provider);
    expect(row).toContain(dense.embeddingSpace.model);
    expect(row).toContain(`${dense.embeddingSpace.dimensions}次元`);
    expect(row).toContain(dense.haystackKind);
    expect(row).toContain(`${dense.hit1Count}/${dense.probeCount}`);
    expect(row).toContain(`${dense.hit10Count}/${dense.probeCount}`);
  });

  it("⚠ 標本の小ささの注意書きが Job Summary に随伴している", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    expect(result.summary).toContain("ADR 0033 §3");
    expect(result.summary).toContain("統計的に主張しない");
  });

  it("ジョブに timeout-minutes が設定されている（既定 360 分で刺さらない）", () => {
    expect(jobBlock).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  /** `action.yml` の `runs.using` は引かない（ネットワークに出ない）。代わりに、ファイル内の他のジョブに後れを取っていないことと、node24 と確認できた版の下限表の2つで挟む。 */
  const NODE24_MIN_MAJOR = {
    // node24 と確認できた最小のメジャー。表に無いメジャーは未確認なので、下限は安全側に寄せてある。
    "actions/checkout": 6,
    "actions/setup-node": 6,
    "actions/upload-artifact": 6,
    "actions/cache": 5,
  };

  /** @param {string} block */
  function usesInBlock(block) {
    return [...block.matchAll(/^\s*uses: (actions\/[a-z-]+)@v(\d+)$/gm)].map((match) => ({
      action: match[1],
      major: Number(match[2]),
    }));
  }

  it("🔴 このジョブの action が ci.yml の他のジョブに後れを取っていない（#127 型の取り残し）", () => {
    const mine = usesInBlock(jobBlock);
    expect(mine.length).toBeGreaterThan(0);
    const fileWide = usesInBlock(workflow);
    for (const { action, major } of mine) {
      const maxMajor = Math.max(
        ...fileWide.filter((used) => used.action === action).map((used) => used.major),
      );
      expect(
        major,
        `${action}: このジョブは @v${major} だが、ci.yml の他所は @v${maxMajor} を使っている`,
      ).toBe(maxMajor);
    }
  });

  it("🔴 このジョブの action が node24 の版である（2026-09-23 に runner から Node 20 が消える）", () => {
    const mine = usesInBlock(jobBlock);
    expect(mine.length).toBeGreaterThan(0);
    for (const { action, major } of mine) {
      const min = NODE24_MIN_MAJOR[action];
      expect(min, `${action} の node24 下限が表に無い（引き直して表を更新すること）`).toBeDefined();
      expect(
        major,
        `${action}@v${major} は node24 だと確認できている下限 v${min} より古い`,
      ).toBeGreaterThanOrEqual(min);
    }
  });

  it("🔴 summary 段に if: always() の実キーが付いている（measure が落ちても Job Summary は残す。Issue #177）", () => {
    expect(summaryStep, "identifier-probe-summary.mjs を打つ段が無い").toBeDefined();
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });

  it("🔴 artifact 段に if: always() の実キーが付いている（measure が落ちても成果物は残す。Issue #177）", () => {
    expect(artifactStep, "成果物を upload する段が無い").toBeDefined();
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });
});

describe("blockDeclaresAlways: 実キーとコメントの引用を区別する（Issue #177）", () => {
  it("陽性: 実キーが if: success() で、地の文コメントだけが if: always() を引用している場合は false", () => {
    const raw = [
      "      - name: 合成した段",
      "        # このステップは常に走る（if: always()）——測っていないことを測っていないと言う。",
      "        if: success()",
      "        run: echo hi",
    ].join("\n");
    const { text } = blankOutWorkflowComments(raw);
    expect(blockDeclaresAlways(text)).toBe(false);
  });

  it("🔴 陰性対照: 実キーが if: always() のままで、コメント側が if: success() を引用していても true", () => {
    const raw = [
      "      - name: 合成した段",
      "        # 通常は if: success() だが、このステップだけは常に走らせる。",
      "        if: always()",
      "        run: echo hi",
    ].join("\n");
    const { text } = blankOutWorkflowComments(raw);
    expect(blockDeclaresAlways(text)).toBe(true);
  });

  it("🔴 陰性対照2: ふるまいを変えないコメントの書き換え・追加をしても true のまま", () => {
    const raw = [
      "      - name: 合成した段",
      "        # 全く無関係なコメント行を1行足す。",
      "        # このステップは常に走る。",
      "        if: always()",
      "        run: echo hi",
    ].join("\n");
    const { text } = blankOutWorkflowComments(raw);
    expect(blockDeclaresAlways(text)).toBe(true);
  });
});

describe("コメント潰しが identifier-probes ジョブの対象範囲で「扱えない」形に当たっていないこと(Issue #177)", () => {
  it("identifier-probes ジョブの全段(name 段)に unhandled が無い", () => {
    stepBlockCommentUnhandled.length = 0;
    for (const step of steps) {
      extractStepBlock(step.name);
    }
    expect(stepBlockCommentUnhandled).toEqual([]);
  });
});
