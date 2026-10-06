import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gateExitCode, summarizeStages } from "../root-test-gate.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * Issue #1812（09/17 マージ分の確かめ直し）まとまり G6 のうち、PR #461（ADR 0210）の
 * ルートの `test` 門に対して、変異を当てて見つかった「すり抜け」だけを固定する歯。
 *
 * 既存の `root-test-gate.test.mjs`（純関数）と `run-db-tests.test.mjs`（`STAGES` の配線）が
 * 既に守っているものは重ねていない。ここで足すのは次の3つ。
 *
 * 1. 要約が「失敗した段」を名指しし、失敗を成功・未起動と取り違えないこと（純関数）。
 * 2. **`run-root-test-gate.mjs`（実行部）が、前段が落ちても後段を必ず起動し、全段の出力を
 *    流し、1つでも落ちれば非0で終わること**——ADR 0210 の芯だが、既存の歯は実行部を一度も
 *    起動していなかった（段2が `pnpm -r run test` を呼ぶので、本物の `STAGES` を歯の中から
 *    起動すると再帰する）。⟹ **実行部の実ファイルを一時ディレクトリへ複写し、`STAGES` だけを
 *    軽い偽の段へ差し替えて起動する**（実行部のコードは1行も書き換えない）。
 * 3. CI の `build` ジョブの `Test` 段が、`pnpm run test` を黙って緑に落とされずに打つこと。
 *
 * 各 `it` の名前の末尾の記号（R1・R10 など）は、Issue #1812 のコメントの変異表の番号である。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptsDir = join(repoRoot, "scripts");

/** @type {string[]} */
const workDirs = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const names = ["stage-one", "stage-two", "stage-three"];

function results(overrides) {
  return names.map((name, i) => ({ name, ran: true, exitCode: 0, ...(overrides[i] ?? {}) }));
}

describe("summarizeStages / gateExitCode: 失敗を、成功とも未起動とも取り違えない（ADR 0210 決定3）", () => {
  it("R5b・R6・R6b・R7: 失敗した段は「✗ 失敗」の行・exit 番号・「失敗した段」の行・門の失敗として出る", () => {
    const summary = summarizeStages(results([{}, { exitCode: 3 }, {}]));
    expect(summary).toContain("✗ 失敗    stage-two（exit 3）");
    expect(summary).toContain("✔ 成功    stage-one（exit 0）");
    expect(summary).toContain("失敗した段: stage-two");
    expect(summary).toContain("門: ✗ 失敗");
    expect(summary).not.toContain("門: ✔ 通過");
    // 3段とも走ったことは、失敗があっても名乗る（未起動と取り違えない）。
    expect(summary).toContain("3/3 段が実際に走りました");
    expect(summary).not.toContain("未起動");
  });

  it("R5b: 失敗した段が複数在れば、全部を「失敗した段」の行に並べる", () => {
    const summary = summarizeStages(results([{ exitCode: 1 }, {}, { exitCode: 2 }]));
    expect(summary).toContain("失敗した段: stage-one, stage-three");
  });

  it("R6c・R7: 未起動の段は「⊘ 未起動」の行で出て、成功の行にならず、門は失敗になる", () => {
    const summary = summarizeStages(results([{}, { ran: false, exitCode: null }, {}]));
    expect(summary).toContain("⊘ 未起動  stage-two");
    expect(summary).not.toContain("✔ 成功    stage-two");
    expect(summary).toContain("門: ✗ 失敗");
  });

  it("R1: ran が false の段は、exitCode が 0 でも「通った」にならない（未起動は検査していない）", () => {
    const stages = results([{}, { ran: false, exitCode: 0 }, {}]);
    expect(gateExitCode(stages)).not.toBe(0);
    expect(summarizeStages(stages)).toContain("2/3 段が実際に走りました");
  });
});

/**
 * 実行部の実ファイルを一時ディレクトリへ複写し、`STAGES` だけを差し替えて起動する。
 * `run-root-test-gate.mjs` は自分の1つ上のディレクトリを `cwd` にして段を起動するので、
 * 一時ディレクトリの `scripts/` に2ファイルを置けばよい。
 *
 * @param {{ name: string; code: string }[]} fakeStages node -e で走らせる偽の段
 */
function runGateWithFakeStages(fakeStages) {
  const workDir = mkdtempSync(join(tmpdir(), "root-test-gate-recheck-"));
  workDirs.push(workDir);
  mkdirSync(join(workDir, "scripts"));
  copyFileSync(
    join(scriptsDir, "run-root-test-gate.mjs"),
    join(workDir, "scripts", "run-root-test-gate.mjs"),
  );
  const stagesSource = JSON.stringify(
    fakeStages.map((s) => ({ name: s.name, command: process.execPath, args: ["-e", s.code] })),
  );
  // 実物の root-test-gate.mjs の末尾に、`STAGES` を中身ごと差し替える1文だけを足す。
  writeFileSync(
    join(workDir, "scripts", "root-test-gate.mjs"),
    `${readFileSync(join(scriptsDir, "root-test-gate.mjs"), "utf8")}\nSTAGES.splice(0, STAGES.length, ...${stagesSource});\n`,
  );
  return spawnSyncWithDeadline(
    process.execPath,
    [join(workDir, "scripts", "run-root-test-gate.mjs")],
    { cwd: workDir, encoding: "utf8" },
  );
}

const ok = (name, marker) => ({
  name,
  code: `console.log(${JSON.stringify(marker)}); console.error(${JSON.stringify(`${marker}-ERR`)});`,
});
const failing = (name, marker, code) => ({
  name,
  code: `console.log(${JSON.stringify(marker)}); process.exit(${code});`,
});

describe("run-root-test-gate.mjs（実行部）: 前段が落ちても後段を必ず起動する（ADR 0210 決定1）", () => {
  it("R14・R15: 段1が落ちても、段2・段3は起動され、出力が流れ、門は非0で終わる", () => {
    const result = runGateWithFakeStages([
      failing("fake-one", "ONE-RAN", 1),
      ok("fake-two", "TWO-RAN"),
      ok("fake-three", "THREE-RAN"),
    ]);
    expect(result.stdout).toContain("ONE-RAN");
    expect(result.stdout).toContain("TWO-RAN");
    expect(result.stdout).toContain("THREE-RAN");
    expect(result.stdout).toContain("3/3 段が実際に走りました");
    expect(result.stdout).toContain("失敗した段: fake-one");
    expect(result.status).not.toBe(0);
  });

  it("R14・R15: 中段・最後の段だけが落ちても、全部が走り、門は非0で終わる", () => {
    const middle = runGateWithFakeStages([
      ok("fake-one", "ONE-RAN"),
      failing("fake-two", "TWO-RAN", 2),
      ok("fake-three", "THREE-RAN"),
    ]);
    expect(middle.stdout).toContain("THREE-RAN");
    expect(middle.stdout).toContain("失敗した段: fake-two");
    expect(middle.status).not.toBe(0);

    const last = runGateWithFakeStages([
      ok("fake-one", "ONE-RAN"),
      ok("fake-two", "TWO-RAN"),
      failing("fake-three", "THREE-RAN", 4),
    ]);
    expect(last.stdout).toContain("失敗した段: fake-three");
    expect(last.status).not.toBe(0);
  });

  it("R13・R11: 全段が通れば exit 0 で、要約は「門: ✔ 通過」を出す", () => {
    const result = runGateWithFakeStages([
      ok("fake-one", "ONE-RAN"),
      ok("fake-two", "TWO-RAN"),
      ok("fake-three", "THREE-RAN"),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("3/3 段が実際に走りました");
    expect(result.stdout).toContain("門: ✔ 通過");
    expect(result.stdout).not.toContain("失敗した段");
  });

  it("R12・R9: 各段の stdout・stderr は握り潰さずそのまま流れ、要約は段の出力の後に出る", () => {
    const result = runGateWithFakeStages([
      ok("fake-one", "ONE-RAN"),
      ok("fake-two", "TWO-RAN"),
      ok("fake-three", "THREE-RAN"),
    ]);
    expect(result.stderr).toContain("ONE-RAN-ERR");
    expect(result.stderr).toContain("THREE-RAN-ERR");
    expect(result.stdout.indexOf("THREE-RAN")).toBeGreaterThanOrEqual(0);
    expect(result.stdout.indexOf("THREE-RAN")).toBeLessThan(
      result.stdout.indexOf("ルートの test 門: 各段の結果"),
    );
  });

  it("R10: signal で死んだ段（exit status が null）も、未起動でも成功でもなく「失敗した段」になる", () => {
    const result = runGateWithFakeStages([
      { name: "fake-killed", code: 'process.kill(process.pid, "SIGKILL");' },
      ok("fake-two", "TWO-RAN"),
      ok("fake-three", "THREE-RAN"),
    ]);
    expect(result.stdout).toContain("THREE-RAN");
    expect(result.stdout).toContain("失敗した段: fake-killed");
    expect(result.stdout).not.toContain("未起動");
    expect(result.status).not.toBe(0);
  });
});

describe("ci.yml の build ジョブの Test 段が、ルートの test 門を黙って緑に落とされずに打つこと（配線）", () => {
  const lines = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8").split("\n");

  /** `  build:` ジョブの行だけを返す。 */
  function jobLines(jobId) {
    const start = lines.findIndex((line) => line === `  ${jobId}:`);
    expect(start, `${jobId} ジョブが無い`).toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^ {2}\S/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end);
  }

  /** 段（`      - name:` で始まる塊）のうち、述語に合う最初のもの。 */
  function stepBlock(block, predicate) {
    const starts = block
      .map((line, i) => (/^ {6}- name:/.test(line) ? i : -1))
      .filter((i) => i >= 0);
    for (let k = 0; k < starts.length; k += 1) {
      const slice = block.slice(starts[k], starts[k + 1] ?? block.length);
      if (predicate(slice)) return { index: k, lines: slice };
    }
    return undefined;
  }

  const code = (blockLines) => blockLines.filter((line) => !/^\s*#/.test(line));

  it("R17: Test 段は `pnpm run test` を1語だけ打ち、continue-on-error・if を持たない", () => {
    const job = jobLines("build");
    const step = stepBlock(job, (s) => s[0].trim() === "- name: Test");
    expect(step, "build ジョブに `- name: Test` の段が無い").toBeDefined();
    const body = code(step.lines);
    expect(body.filter((l) => /^\s*run:/.test(l)).map((l) => l.trim())).toEqual([
      "run: pnpm run test",
    ]);
    expect(body.filter((l) => /^\s*continue-on-error:/.test(l))).toEqual([]);
    expect(body.filter((l) => /^\s+if:/.test(l))).toEqual([]);
  });

  it("R17: build ジョブ自体が continue-on-error・if を宣言しない（required の `typecheck / lint / test / build` を黄色にしない）", () => {
    const job = code(jobLines("build"));
    const jobHeader = job.slice(
      0,
      job.findIndex((l) => /^ {4}steps:/.test(l)),
    );
    expect(jobHeader.filter((l) => /^ {4}(continue-on-error|if):/.test(l))).toEqual([]);
  });
});
