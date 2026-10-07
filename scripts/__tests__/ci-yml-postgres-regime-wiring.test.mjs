import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findInconsistentLegs, parseInitdbArgs } from "../initdb-args-lib.mjs";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { normalizeWorkflowExpressions } from "../workflow-expression-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "postgres";

/** `normalizeWorkflowExpressions` を通したあとの形で照合する（`${{ }}` の中の書き方は要求しない）。 */
const ARTIFACT_NAME_CANONICAL = "name: lexical-regime-${{ matrix.serverEncoding }}";
const TOOTH_SOURCE_PATH = fileURLToPath(
  new URL(
    "../../packages/postgres/src/__tests__/lexical-store-identifier.test.ts",
    import.meta.url,
  ),
);

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
      `ci.yml に \`  ${jobId}:\` のジョブが無い。Issue #148 が対象にしているジョブが消えたか、` +
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

const benchStep = steps.find((step) => step.env.MNEMORA_LEXICAL_REGIME_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("lexical-regime-summary.mjs"));
const artifactStep = steps.find(
  (step) => step.name.includes("成果物として残す") && step.name.includes("Issue #148"),
);

/**
 * @type {{ stepName: string, unhandled: { lineNumber: number, reason: string, line: string }[] }[]}
 */
const stepBlockCommentUnhandled = [];

/**
 * 返す前にコメントを空白へ潰す（コメントが引用しているだけでも `toContain` が一致するため）。
 * 照合専用であり、実際に走らせる側（`jobBlock`/`parseSteps`）には適用しない。
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
 * summary 段は bash へ直接渡すので、`${{ }}` はここで自分で展開する。
 *
 * @param {string} text
 * @param {{ workspace: string, leg?: { serverEncoding: string, initdbArgs: string } }} substitutions
 * @returns {string}
 */
function substituteWorkspace(text, { workspace, leg }) {
  let replaced = text.replaceAll("${{ github.workspace }}", workspace);
  if (leg) {
    replaced = replaced
      .replaceAll("${{ matrix.serverEncoding }}", leg.serverEncoding)
      .replaceAll("${{ matrix.initdbArgs }}", leg.initdbArgs);
  }
  if (replaced.includes("${{")) {
    throw new Error(
      `この歯が解釈できない GitHub Actions の式が残っている: ${replaced}。` +
        "式が増えたなら、この歯の置き換えのほうを足すこと(歯を消さないこと)。",
    );
  }
  return replaced;
}

/**
 * パスは書き写さず yml から読む（書き写すと、yml が変わったとき歯が古いまま緑になる）。
 *
 * @returns {string}
 */
function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の postgres ジョブに MNEMORA_LEXICAL_REGIME_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_LEXICAL_REGIME_JSON;
}

function makeValidRegime(overrides = {}) {
  return {
    schemaVersion: 2,
    measuredAt: "2026-09-12T00:00:00.000Z",
    serverVersion: "PostgreSQL 17.11",
    serverEncoding: "UTF8",
    nonAsciiIsIndexed: true,
    rawTsvector: "'1234':2 '四半期レビューでproj':1",
    rawIdentifierHit: false,
    rawJapaneseWordHit: false,
    regime: "non_ascii_indexed",
    lcCollate: "en_US.UTF-8",
    lcCtype: "en_US.UTF-8",
    defaultTextSearchConfig: "pg_catalog.simple",
    ...overrides,
  };
}

/** @type {{ serverEncoding: string, initdbArgs: string }} */
const DEFAULT_LEG = { serverEncoding: "UTF8", initdbArgs: "--encoding=UTF8" };

/**
 * @param {"present" | "missing"} fileState `"missing"` なら measured ファイルを
 *   一切書かず、ENOENT の経路を実地で走らせる。
 * @param {unknown} [content] `fileState: "present"` のときにファイルへ書く中身
 *   (JSON.stringify する。文字列を渡せばそのまま書く——壊れた JSON も作れる)。
 * @param {{ serverEncoding: string, initdbArgs: string }} [leg] `${{ matrix.* }}` を
 *   どの脚の値として展開するか(既定は UTF8 脚)。
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(fileState, content, leg = DEFAULT_LEG) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の postgres ジョブに lexical-regime-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-postgres-regime-wiring-"));
  try {
    const script = substituteWorkspace(summaryStep.run, { workspace, leg });
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), { workspace });
    if (fileState === "present") {
      writeFileSync(
        measuredPath,
        typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
        "utf8",
      );
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

describe("ci.yml の postgres ジョブの regime 配線(Issue #148)", () => {
  it("ジョブ自体が存在する(measure/summary/artifact の3段を持つ)", () => {
    expect(benchStep, "MNEMORA_LEXICAL_REGIME_JSON を渡す測定段が無い").toBeDefined();
    expect(summaryStep, "lexical-regime-summary.mjs を打つ段が無い").toBeDefined();
    expect(artifactStep, "regime を upload する段が無い").toBeDefined();
  });

  it("⭐ 歯が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("DATABASE_URL が設定され、pgvector の service container を使っている", () => {
    expect(jobEnv.DATABASE_URL).toBeDefined();
    expect(jobBlock).toContain("pgvector/pgvector");
  });

  it("test:db の段が MNEMORA_LEXICAL_REGIME_JSON を渡している", () => {
    expect(benchStep.run).toContain("run test:db");
  });

  it("要約ステップに if: always() が付いている(測定段が落ちても走る)", () => {
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("artifact ステップにも if: always() が付いている(測定段が落ちても成果物は残す)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("実測値そのものを artifact として upload-artifact に渡している(歯の書き先と同じパス、if-no-files-found: ignore)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block).toContain("uses: actions/upload-artifact@v");
    expect(block).toContain(benchStepMeasuredPath());
    expect(block).toContain("if-no-files-found: ignore");
  });

  it("🔴 Issue #155/#163: artifact 名が matrix.serverEncoding へ配線されている(脚ごとに分かれていないと上書き・衝突する)", () => {
    const block = extractStepBlock(artifactStep.name);
    const { text, unhandled } = normalizeWorkflowExpressions(block ?? "");
    expect(
      unhandled,
      "artifact 段に、照合専用の網が正規化できない ${{ … }} が在る。" +
        "網が黙って素通りしたまま緑になるのを防ぐため、ここで名乗らせている。",
    ).toEqual([]);
    expect(text).toContain(ARTIFACT_NAME_CANONICAL);
  });

  it("🔴 Issue #163: 正規化しても、artifact 名の接頭辞と脚ごとの分岐そのものは消えていない(網が式を丸ごと畳んでいないことの固定)", () => {
    const block = extractStepBlock(artifactStep.name);
    const { text } = normalizeWorkflowExpressions(block ?? "");
    expect(text).toContain("${{ matrix.serverEncoding }}");
    expect(text).not.toContain("name: lexical-regime-UTF8");
  });

  it("⭐ 正常な JSON なら exit 0 で、Job Summary に server_encoding / server_version が出る(UTF8 脚)", () => {
    const result = runSummaryStepFromWorkflow("present", makeValidRegime());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("server_encoding");
    expect(result.summary).toContain("server_version");
    expect(result.summary).toContain("UTF8");
  });

  it("🔴 Issue #155: SQL_ASCII 脚として走らせても、宣言と実測が一致していれば exit 0", () => {
    const sqlAsciiLeg = {
      serverEncoding: "SQL_ASCII",
      initdbArgs: "--encoding=SQL_ASCII --locale=C",
    };
    const result = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({
        serverEncoding: "SQL_ASCII",
        nonAsciiIsIndexed: false,
        regime: "non_ascii_dropped",
        rawIdentifierHit: true,
      }),
      sqlAsciiLeg,
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("SQL_ASCII");
  });

  it("🔴 Issue #155: SQL_ASCII 脚として渡しているのに実測が UTF8 だと exit 1(宣言と実測の食い違い——matrix でも門は生きている)", () => {
    const sqlAsciiLeg = {
      serverEncoding: "SQL_ASCII",
      initdbArgs: "--encoding=SQL_ASCII --locale=C",
    };
    const result = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({ serverEncoding: "UTF8" }),
      sqlAsciiLeg,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SQL_ASCII");
    expect(result.stderr).toContain("UTF8");
  });

  it("🔴 nonAsciiIsIndexed が true でも false でも exit 0(⛔ 門ではないことの固定点)", () => {
    const trueResult = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({ nonAsciiIsIndexed: true, regime: "non_ascii_indexed" }),
    );
    expect(trueResult.status, `stderr: ${trueResult.stderr}`).toBe(0);

    const falseResult = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({
        nonAsciiIsIndexed: false,
        regime: "non_ascii_dropped",
        rawIdentifierHit: true,
      }),
    );
    expect(falseResult.status, `stderr: ${falseResult.stderr}`).toBe(0);
  });

  it("🔴 ファイルが無ければ非0(「値が出ていない」——測定段自体が落ちていないか先に見る経路)", () => {
    const result = runSummaryStepFromWorkflow("missing");
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("🔴 値が空文字なら非0で、かつ「ファイルが無い」場合とは異なるメッセージになる", () => {
    const emptyResult = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({ serverEncoding: "" }),
    );
    expect(emptyResult.status).not.toBe(0);
    const missingResult = runSummaryStepFromWorkflow("missing");
    expect(missingResult.status).not.toBe(0);
    expect(emptyResult.stderr).not.toBe(missingResult.stderr);
  });

  it("実測 JSON が壊れている(JSON として parse できない)と非0", () => {
    const result = runSummaryStepFromWorkflow("present", "{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });
});

/**
 * コメントだけを空白へ潰す（改行と添字は保つ）。正規表現リテラル中の `//` は見分けない。
 *
 * @param {string} source
 * @returns {string}
 */
export function blankOutComments(source) {
  let out = "";
  let state = "code";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        state = ch;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
        i += 1;
        continue;
      }
      out += " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (ch === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === state) {
      state = "code";
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("値を作る側の歯が MNEMORA_LEXICAL_REGIME_JSON を参照していること(Issue #148)", () => {
  const toothSource = readFileSync(TOOTH_SOURCE_PATH, "utf8");
  // コメントを潰してから当てる（素のソースだと docstring に同じ文字列があるだけで緑になる）。`toothSource` に戻さない。
  const toothCode = blankOutComments(toothSource);

  it("MNEMORA_LEXICAL_REGIME_JSON を参照している", () => {
    expect(toothCode).toContain("MNEMORA_LEXICAL_REGIME_JSON");
  });

  it("`expect` より前に書き込んでいる(歯が赤くなっても値が残るための順序)", () => {
    const writeIndex = toothCode.indexOf("writeFileSync(regimeJsonPath");
    expect(writeIndex, "writeFileSync(regimeJsonPath, …) の呼び出しが見当たらない").toBeGreaterThan(
      -1,
    );
    const firstExpectAfterProbeIndex = toothCode.indexOf("expect(\n        row.rawIdentifierHit,");
    expect(
      firstExpectAfterProbeIndex,
      "この歯の1本目の expect(row.rawIdentifierHit, …) が見当たらない——歯の書き方が" +
        "変わった可能性がある。取り出し方を直すこと。",
    ).toBeGreaterThan(-1);
    expect(writeIndex).toBeLessThan(firstExpectAfterProbeIndex);
  });

  it("lcCollate / lcCtype / defaultTextSearchConfig を参照している(ロケールを測り始めたこと)", () => {
    expect(toothCode).toContain("lcCollate");
    expect(toothCode).toContain("lcCtype");
    expect(toothCode).toContain("defaultTextSearchConfig");
    // 名前だけでなく実際に問い合わせていることも固定する。
    // lc_collate / lc_ctype は PG16 から GUC ではないので pg_database から引き、text search config だけ GUC から引く。
    // 空白は桁揃えの変更で赤くならないよう `\s+` で受ける。
    const probeExpressions = [
      ["lcCollate", /SELECT\s+datcollate\s+FROM\s+pg_database/],
      ["lcCtype", /SELECT\s+datctype\s+FROM\s+pg_database/],
      ["defaultTextSearchConfig", /current_setting\('default_text_search_config'\)/],
    ];
    for (const [field, expression] of probeExpressions) {
      expect(
        toothCode,
        `probe の SQL が ${field} を実際に問い合わせていない（期待する式: ${expression}）。` +
          "JSON の欄と TS の型だけが残ると、値は undefined になり、" +
          "Job Summary 側の validateMeasured が「値が空だった」で落ちるまで誰も気づかない。",
      ).toMatch(expression);
    }
    expect(
      toothCode.includes("current_setting('lc_collate')") ||
        toothCode.includes("current_setting('lc_ctype')"),
      "probe が lc_collate / lc_ctype を GUC として引いている。PostgreSQL 16 以降では " +
        "存在しないパラメータなので 42704 で落ちる。pg_database.datcollate / datctype を使うこと。",
    ).toBe(false);
  });

  it("schemaVersion: 2 である(ロケール3項目を足した版であることの固定点)", () => {
    expect(toothCode).toContain("schemaVersion: 2");
  });
});

describe("ci.yml の pgvector ジョブが regime を宣言していること(Issue #148 ②/Issue #155/Issue #224)", () => {
  // 絶対本数は固定しない（並行 PR が1本ずつ足すと、どちらが正しく数え直しても食い違う。ADR 0127）。

  /**
   * ジョブをまたぐため `extractJob` は使わず、インデントの形だけを頼りに生の行を見る。
   *
   * @returns {{ envLines: string[] }[]}
   */
  function extractPgvectorServiceEnvBlocks() {
    const lines = workflow.split("\n");
    /** @type {{ envLines: string[] }[]} */
    const blocks = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] !== "        image: pgvector/pgvector:pg17") {
        continue;
      }
      const envAt = i + 1;
      if (lines[envAt] !== "        env:") {
        throw new Error(
          `pgvector/pgvector:pg17 の直後に \`        env:\` が無い(行 ${envAt + 1})。` +
            "services ブロックの形が変わった可能性がある。",
        );
      }
      const envLines = [];
      let j = envAt + 1;
      while (j < lines.length && /^ {10}\S/.test(lines[j])) {
        envLines.push(lines[j]);
        j += 1;
      }
      blocks.push({ envLines });
    }
    return blocks;
  }

  /**
   * @param {string[]} envLines
   * @returns {Record<string, string>}
   */
  function parseEnvLines(envLines) {
    /** @type {Record<string, string>} */
    const env = {};
    for (const line of envLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        continue;
      }
      const matched = /^([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(trimmed);
      if (matched) {
        env[matched[1]] = matched[2];
      }
    }
    return env;
  }

  /**
   * @returns {{ serverEncoding: string, initdbArgs: string }[]}
   */
  function extractMatrixLegs() {
    const lines = jobBlock.split("\n");
    const includeAt = lines.findIndex((line) => line === "        include:");
    if (includeAt === -1) {
      throw new Error(
        "ci.yml の postgres ジョブに strategy.matrix.include が無い(Issue #155 の matrix 化が外れている)。",
      );
    }
    /** @type {{ serverEncoding: string, initdbArgs: string }[]} */
    const legs = [];
    /** @type {{ serverEncoding: string, initdbArgs?: string } | undefined} */
    let current;
    for (let i = includeAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      const legStart = /^ {10}- serverEncoding: (.+)$/.exec(line);
      if (legStart) {
        if (current?.initdbArgs !== undefined) {
          legs.push(/** @type {{ serverEncoding: string, initdbArgs: string }} */ (current));
        }
        current = { serverEncoding: legStart[1].trim() };
        continue;
      }
      const initdbArgsMatched = /^ {12}initdbArgs: "(.*)"$/.exec(line);
      if (initdbArgsMatched && current) {
        current.initdbArgs = initdbArgsMatched[1];
        continue;
      }
      if (line.trim() === "" || line.trim().startsWith("#")) {
        continue;
      }
      if (!/^ {10,}/.test(line)) {
        break;
      }
    }
    if (current?.initdbArgs !== undefined) {
      legs.push(/** @type {{ serverEncoding: string, initdbArgs: string }} */ (current));
    }
    return legs;
  }

  const serviceBlocks = extractPgvectorServiceEnvBlocks();
  const matrixLegs = extractMatrixLegs();

  it("(a) image: pgvector/pgvector:pg17 の services ブロックが1本以上あり、全部が POSTGRES_INITDB_ARGS を持つ(Issue #224: 絶対本数は問わない)", () => {
    expect(
      serviceBlocks.length,
      "pgvector/pgvector:pg17 の services ブロックが1本も無い(抽出が壊れたか、pgvector ジョブが全部消えた)。",
    ).toBeGreaterThan(0);
    for (const block of serviceBlocks) {
      const env = parseEnvLines(block.envLines);
      expect(
        env.POSTGRES_INITDB_ARGS,
        "POSTGRES_INITDB_ARGS を持たない pgvector の services ブロックがある(Issue #148 ②)",
      ).toBeDefined();
    }
  });

  it("🔴 Issue #155: postgres ジョブに strategy.matrix.include が2脚(UTF8/SQL_ASCII)ある", () => {
    expect(matrixLegs.map((leg) => leg.serverEncoding).sort()).toEqual(["SQL_ASCII", "UTF8"]);
  });

  it("🔴 Issue #155: strategy.fail-fast が false である(SQL_ASCII 脚が落ちても UTF8 脚の証拠を残す)", () => {
    expect(jobBlock).toMatch(/fail-fast:\s*false/);
  });

  it("(b) ⭐ matrix 配線はちょうど1本であり、matrix 化していない残り全部の POSTGRES_INITDB_ARGS は、matrix の UTF8 脚の initdbArgs と一致する(Issue #224: 本数そのものは問わない。『1本(いまは1脚)で測った regime が他ジョブに効く』根拠そのもの)", () => {
    const values = serviceBlocks.map((block) => parseEnvLines(block.envLines).POSTGRES_INITDB_ARGS);
    const matrixWired = values.filter((value) => value === "${{ matrix.initdbArgs }}");
    const fixedValues = values.filter((value) => value !== "${{ matrix.initdbArgs }}");

    expect(
      matrixWired,
      "postgres ジョブの POSTGRES_INITDB_ARGS が ${{ matrix.initdbArgs }} へ配線されていない" +
        "(matrix 化が外れたか、matrix 配線されたジョブが2本以上になった——ADR 0127 は" +
        "『matrix 配線はちょうど1本』を不変条件として残している)。",
    ).toHaveLength(1);
    expect(
      fixedValues.length,
      "matrix 化していない pgvector ジョブが1本も無い(全ジョブが matrix 配線されている?)。",
    ).toBeGreaterThan(0);

    const utf8Leg = matrixLegs.find((leg) => leg.serverEncoding === "UTF8");
    expect(utf8Leg, "postgres ジョブの matrix に UTF8 脚が無い").toBeDefined();

    const distinctFixed = new Set(fixedValues);
    expect(
      distinctFixed.size,
      `matrix 化していない pgvector ジョブの POSTGRES_INITDB_ARGS が同一でない: ${JSON.stringify(fixedValues)}。` +
        "packages/postgres ジョブでしか regime を実測していない前提が崩れる(ADR 0106)。",
    ).toBe(1);
    const fixedValueUnquoted = [...distinctFixed][0]?.replace(/^"(.*)"$/, "$1");
    expect(
      fixedValueUnquoted,
      "matrix 化していない pgvector ジョブの値が、postgres ジョブの matrix の UTF8 脚と食い違う。" +
        "UTF8 脚は過去の実測との比較可能性のため1バイトも変えない約束である。",
    ).toBe(utf8Leg?.initdbArgs);
  });

  it("(c) ⭐ matrix の各脚は自己無矛盾(--encoding= の値がその脚の serverEncoding と一致する)", () => {
    expect(matrixLegs.length).toBeGreaterThan(0);
    for (const leg of matrixLegs) {
      const match = /--encoding=([^\s"]+)/.exec(leg.initdbArgs);
      expect(
        match,
        `脚 ${leg.serverEncoding} の initdbArgs から --encoding= を取り出せない`,
      ).not.toBeNull();
      expect(
        match?.[1],
        `脚 ${leg.serverEncoding} の initdbArgs の --encoding=(${match?.[1]}) が` +
          "自身の serverEncoding と食い違う",
      ).toBe(leg.serverEncoding);
    }
  });

  it("(c'') ⭐ matrix の各脚は --locale= も含めて自己無矛盾(--locale= が含意する encoding と serverEncoding が一致する。Issue #162 E)", () => {
    const flagged = findInconsistentLegs(matrixLegs);
    expect(
      flagged,
      flagged
        .map((leg) => `脚 ${leg.serverEncoding}(initdbArgs=${leg.initdbArgs}): ${leg.reason}`)
        .join("\n"),
    ).toEqual([]);
  });

  it("(c''') ⭐ 陰性対照(空回り防止): 現物の脚のうち --locale= を持つものからだけ --locale= を剥がすと、剥がした脚だけが挙がる(Issue #162 E)", () => {
    // 空=空だけの陰性対照は「何も測っていない」場合と区別できないので、現物の matrixLegs を混合の材料にする。
    const hasLocale = (/** @type {{ initdbArgs: string }} */ leg) =>
      parseInitdbArgs(leg.initdbArgs).locale !== undefined;
    const withLocale = matrixLegs.filter(hasLocale);
    const withoutLocale = matrixLegs.filter((leg) => !hasLocale(leg));

    expect(new Set(withLocale.map((leg) => leg.serverEncoding))).not.toEqual(new Set());
    expect(new Set(withoutLocale.map((leg) => leg.serverEncoding))).not.toEqual(new Set());

    const perturbed = matrixLegs.map((leg) =>
      hasLocale(leg) ? { ...leg, initdbArgs: leg.initdbArgs.replace(/\s*--locale=\S+/, "") } : leg,
    );
    const flagged = findInconsistentLegs(perturbed);
    expect(new Set(flagged.map((leg) => leg.serverEncoding))).toEqual(
      new Set(withLocale.map((leg) => leg.serverEncoding)),
    );
  });

  it("(c') ⭐ service env の POSTGRES_INITDB_ARGS と summary 段の --expect-encoding は、どちらも同じ matrix 変数へ直接配線されている(値を書き写すのではなく、実行時に自動で揃う)", () => {
    const values = serviceBlocks.map((block) => parseEnvLines(block.envLines).POSTGRES_INITDB_ARGS);
    expect(
      values.filter((value) => value === "${{ matrix.initdbArgs }}"),
      "postgres ジョブの POSTGRES_INITDB_ARGS が ${{ matrix.initdbArgs }} という式そのもの" +
        "になっていない(リテラル値を書いてしまうと、脚によって食い違う余地が生まれる)。",
    ).toHaveLength(1);

    const expectFlag = /--expect-encoding\s+"([^"]+)"/.exec(summaryStep?.run ?? "");
    expect(expectFlag, "summary 段に --expect-encoding の指定が無い").not.toBeNull();
    expect(
      expectFlag?.[1],
      "summary 段の --expect-encoding がリテラル値になっている。" +
        "${{ matrix.serverEncoding }} という式そのものへ配線すること" +
        "(そうしないと、脚が増えたときにこの値だけ古いまま残りうる)。",
    ).toBe("${{ matrix.serverEncoding }}");
  });
});

describe("blankOutComments 自体が効いていること(⭐ この可視化が壊れても気づけるため)", () => {
  it("コメントにだけ在る文字列は、潰したあと残らない", () => {
    const source = [
      "/**",
      " * schemaVersion: 2 はコメントにだけ在る。",
      " */",
      "const a = 1; // schemaVersion: 2 も行コメントに在る",
      "",
    ].join("\n");
    expect(source, "前提: 素のソースには在る").toContain("schemaVersion: 2");
    expect(
      blankOutComments(source),
      "コメントにだけ在る文字列が潰されていない——素のソースへ当てるのと同じことになる",
    ).not.toContain("schemaVersion: 2");
  });

  it("コードに在る文字列は、潰しても残る", () => {
    const source = ["/** schemaVersion: 2 の説明 */", "const x = { schemaVersion: 2 };", ""].join(
      "\n",
    );
    expect(blankOutComments(source)).toContain("schemaVersion: 2");
  });

  it("文字列リテラルの中の // は潰さない", () => {
    const source = 'const url = "https://example.invalid/ok";\n';
    expect(blankOutComments(source)).toContain("https://example.invalid/ok");
  });

  it("添字が元のソースと一致する(順序の固定が壊れないための性質)", () => {
    const source = ["const a = 1; // 消える", "/* 消える */ const b = 2;", ""].join("\n");
    const blanked = blankOutComments(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.indexOf("const b")).toBe(source.indexOf("const b"));
  });

  it("行数が変わらない(改行を残している)", () => {
    const source = ["/*", " * 2行のブロックコメント", " */", "const a = 1;", ""].join("\n");
    const countLines = (text) => text.split("\n").length;
    expect(countLines(blankOutComments(source))).toBe(countLines(source));
  });
});

describe("コメント潰しが postgres ジョブの対象範囲で「扱えない」形に当たっていないこと(段1)", () => {
  it("postgres ジョブの全段(name 段)に unhandled が無い", () => {
    stepBlockCommentUnhandled.length = 0;
    for (const step of steps) {
      extractStepBlock(step.name);
    }
    expect(stepBlockCommentUnhandled).toEqual([]);
  });
});
