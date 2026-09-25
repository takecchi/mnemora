import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/correction-candidate-probe-summary.mjs` の歯（ADR 0291/0321）。**本物の
 * スクリプトを子プロセスとして実際に起動する**（`numeral-token-probe-summary.test.mjs`
 * と同じ形）——「CLI としての配線」（引数の読み方・ファイル I/O・**exit code**）は
 * ここでしか測れない。
 *
 * 🔴 **このファイルが固定している線**:
 *
 * 1. **基準値と相違しても exit 0**（⛔ 門ではない。ADR 0291 §4 決定7）。
 * 2. **`status: "weights_unavailable"` でも exit 0**、かつ比較を1つも出さない。
 * 3. **入力そのものが壊れていれば非0**。
 *
 * DB もネットワークも要求しない。
 */

const script = fileURLToPath(new URL("../correction-candidate-probe-summary.mjs", import.meta.url));

function makeSummary(overrides = {}) {
  return {
    hitCount: 21,
    hitAtK: { 1: 20, 3: 21, 5: 21, 10: 21 },
    mrr: 0.9762,
    distractorBeatsGoldCount: 0,
    goldScoreMin: 0.8756,
    goldScoreMax: 0.9588,
    abstainCount: 32,
    protectedAtTopCount: 20,
    shallowMisfireCount: 12,
    abstainedCount: 0,
    abstainTopScoreMin: 0.81,
    abstainTopScoreMax: 0.935,
    marginStats: { count: 20, mean: 0.0531, stdDev: 0.0207, min: 0.0169 },
    intrusionMarginStats: { count: 20, mean: 0, stdDev: 0, min: 0 },
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-25T00:00:00.000Z",
    commit: "abc123",
    caseSet: "eval",
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    summary: makeSummary(),
    hits: [],
    abstains: [],
    ...overrides,
  };
}

function baselineFrom(measured) {
  return { snapshot: structuredClone(measured) };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "correction-candidate-probe-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("correction-candidate-probe-summary.mjs(子プロセスで起動)", () => {
  it("--measured だけを渡すと exit 0 で、差分節を出さない", () => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
    expect(result.stdout).toContain("A群");
    expect(result.stdout).toContain("B群");
  });

  it("基準値と一致するときは exit 0 で『一致』と出す", () => {
    const measured = makeMeasured();
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baselineFrom(measured)),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致(差分なし)");
  });

  it("🔴 基準値の誤爆・深と相違するときも exit 0(⛔ 門ではないことをここで固定する)", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.snapshot.summary.protectedAtTopCount = 32; // 「全件深い誤爆」に相当
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した項目が");
    expect(result.stdout).toContain("summary.protectedAtTopCount");
  });

  it("status: weights_unavailable のときは exit 0 で、比較を1つも出さない", () => {
    const measured = {
      schemaVersion: 1,
      status: "weights_unavailable",
      measuredAt: "2026-09-25T00:00:00.000Z",
      commit: null,
      detail: "重みを取得できなかった",
    };
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baselineFrom(makeMeasured())),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("重みを取得できなかった");
    expect(result.stdout).not.toContain("一致(差分なし)");
    expect(result.stdout).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("--measured を渡さないと非0", () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
  });

  it("実測 JSON が壊れている(summary が無い)と非0", () => {
    const broken = makeMeasured();
    delete broken.summary;
    const result = run(["--measured", writeJson("measured.json", broken)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("summary");
  });

  it("実測 JSON が JSON として parse できないと非0", () => {
    const path = writeJson("measured.json", "{ not json");
    const result = run(["--measured", path]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("parse");
  });
});
