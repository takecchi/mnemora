import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/numeral-token-probe-summary.mjs` の歯(ADR 0135)。**本物のスクリプトを
 * 子プロセスとして実際に起動する**(`identifier-probe-summary.test.mjs` と同じ形)——
 * `numeral-token-probe-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・**exit code**)はここでしか測れない。
 *
 * 🔴 **このファイルが固定している線**:
 *
 * 1. **基準値と相違しても exit 0**(⛔ 門ではない。ADR 0135 §4-8)。
 * 2. **`status: "weights_unavailable"` でも exit 0**、かつ比較を1つも出さない。
 * 3. **入力そのものが壊れていれば非0**。
 *
 * DB もネットワークも要求しない。
 */

const script = fileURLToPath(new URL("../numeral-token-probe-summary.mjs", import.meta.url));

function makeGroup(overrides = {}) {
  return {
    label: "numeral-token-probes/sparse(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=sparse)",
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    haystackKind: "sparse",
    mrrOverall: 0.917,
    hit1Count: 15,
    hit10Count: 18,
    probeCount: 18,
    marginStats: { count: 18, mean: 0.0375, stdDev: 0.019, min: 0.0105 },
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-25T00:00:00.000Z",
    commit: "abc123",
    sparse: makeGroup(),
    dense: makeGroup({
      label:
        "numeral-token-probes/dense(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=dense)",
      haystackKind: "dense",
    }),
    ...overrides,
  };
}

function baselineFrom(measured) {
  return {
    groups: [
      { group: "sparse", ...structuredClone(measured.sparse) },
      { group: "dense", ...structuredClone(measured.dense) },
    ],
  };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "numeral-token-probe-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("numeral-token-probe-summary.mjs(子プロセスで起動)", () => {
  it("--measured だけを渡すと exit 0 で、差分節を出さない", () => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
    expect(result.stdout).toContain("numeral-token-probes/sparse");
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

  it("🔴 基準値の margin(min)と相違するときも exit 0(⛔ 門ではないことをここで固定する)", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups[0].marginStats.min = -0.5; // 「登録した distractor に負けた」に相当
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した群が 1 件ある");
    expect(result.stdout).toContain("marginStats.min");
  });

  it("🔴 weights_unavailable でも exit 0、比較を1つも出さない", () => {
    const result = run([
      "--measured",
      writeJson("weights.json", {
        schemaVersion: 1,
        status: "weights_unavailable",
        measuredAt: "2026-09-25T00:00:00.000Z",
        commit: "abc123",
        detail: "HTTP 503 from the model host",
      }),
      "--baseline",
      writeJson("baseline.json", baselineFrom(makeMeasured())),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("重みを取得できなかったので、値は測っていない");
    expect(result.stdout).not.toContain("基準値との差分");
    expect(result.stdout).not.toContain("ruri-v3-30m/sym");
  });

  it("--measured を渡さないと非0", () => {
    expect(run([]).status).not.toBe(0);
  });

  it("--measured の中身が壊れた JSON(構文エラー)だと非0", () => {
    const result = run(["--measured", writeJson("broken.json", "{ これは JSON ではない")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured の群に marginStats が無いと非0", () => {
    const measured = makeMeasured();
    delete measured.dense.marginStats;
    const result = run(["--measured", writeJson("missing-margin.json", measured)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dense.marginStats");
  });

  it("--baseline の群に group キーが無いと非0", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    delete baseline.groups[0].group;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("group");
  });
});
