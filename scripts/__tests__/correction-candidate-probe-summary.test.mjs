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

/**
 * ADR 0333 §3.2 案2「別名 `protectionMargin` を新設し `intrusionMargin` は凍結」——
 * `protectionMarginStats` は `intrusionMarginStats` と並べて出すが、🔴 **`DIFF_FIELDS`
 * （基準値との一致/相違判定）には加えていない**。この節はその2点を固定する:
 *
 * 1. measured に `protectionMarginStats` があれば、B群の表に intrusionMargin と
 *    並んで出る。
 * 2. `protectionMarginStats` が基準値と実測でどれだけ違っても、既存の「一致(差分なし)」
 *    判定・exit code は1つも動かない——差の大きさに関わらず「参考」節にだけ現れる。
 *
 * ⭐ **この歯が実際に噛むことを、変異試験で示した**（報告に記録）。
 */
describe("protectionMargin(ADR 0333 案2)は並べて出るが、DIFF_FIELDS には入らない", () => {
  it("--measured だけでも、protectionMarginStats があれば B群の表に並べて出る", () => {
    const measured = makeMeasured({
      summary: makeSummary({
        protectionMarginStats: { count: 24, mean: 0.030195, stdDev: 0.022252, min: -0.008776 },
      }),
    });
    const result = run(["--measured", writeJson("measured.json", measured)]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("protectionMargin");
    expect(result.stdout).toContain("intrusionMargin");
  });

  it("measured に protectionMarginStats が無くても(旧い実測)exit 0のまま", () => {
    const measured = makeMeasured(); // makeSummary() の既定値には protectionMarginStats が無い
    const result = run(["--measured", writeJson("measured.json", measured)]);
    expect(result.status, result.stderr).toBe(0);
  });

  it("基準値が旧い(protectionMarginStats が無い)ときも一致判定・exit 0に影響しない", () => {
    const measured = makeMeasured({
      summary: makeSummary({
        protectionMarginStats: { count: 24, mean: 0.030195, stdDev: 0.022252, min: -0.008776 },
      }),
    });
    // baseline は measured と同じ値から作るが、protectionMarginStats を持たない旧い形にする。
    const baselineSnapshot = structuredClone(measured);
    delete baselineSnapshot.summary.protectionMarginStats;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", { snapshot: baselineSnapshot }),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致(差分なし)");
    expect(result.stdout).toContain("基準値に `protectionMarginStats` が無い");
  });

  it("🔴 protectionMarginStats が基準値と大きく相違しても、一致(差分なし)のまま・exit 0のまま", () => {
    const measured = makeMeasured({
      summary: makeSummary({
        protectionMarginStats: { count: 24, mean: 0.030195, stdDev: 0.022252, min: -0.008776 },
      }),
    });
    const baseline = baselineFrom(measured);
    // protectionMarginStats だけを大きく変える(他の DIFF_FIELDS 対象は一致させたまま)。
    baseline.snapshot.summary.protectionMarginStats = {
      count: 24,
      mean: -999,
      stdDev: 0,
      min: -999,
    };
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    // ⭐ 陽性対照: DIFF_FIELDS に本当に入っていたら、ここは「相違した項目が」に
    // なるはずである(下の変異試験で実際に確認する)。protectionMarginStats は
    // DIFF_FIELDS の対象外なので、他のすべてのフィールドが一致していればここは
    // 「一致(差分なし)」のままになる。
    expect(result.stdout).toContain("一致(差分なし)");
    expect(result.stdout).not.toContain("相違した項目が");
    // 「参考」節には両方の値が出る(指数表記、`formatMargin` と同じ桁数)。
    expect(result.stdout).toContain("参考: protectionMargin");
    expect(result.stdout).toContain("-9.990e+2");
  });

  it("summary.protectionMarginStats の形が壊れていれば非0(在るときだけ検査する)", () => {
    const measured = makeMeasured({
      summary: makeSummary({ protectionMarginStats: { count: "not-a-number" } }),
    });
    const result = run(["--measured", writeJson("measured.json", measured)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("protectionMarginStats");
  });
});
