import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/recall-footprint-calibration-samples-summary.mjs` の歯(Issue #340
 * フォローアップ、ADR 0307)。**本物のスクリプトを子プロセスとして実際に起動する**
 * (`scripts/__tests__/consolidation-cost-summary.test.mjs` と同じ判断)——
 * `recall-footprint-calibration-samples-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・exit code)はここでしか測れない。
 *
 * DB は要求しない——このスクリプトは JSON ファイル1〜2個を読むだけである。
 *
 * ⛔ この bench の基準値ファイルはまだ存在しない(ADR 0307 §2)。ここで使う
 * measured/baseline はすべてこの歯の中で組み立てたインライン fixture である。
 */

const script = fileURLToPath(
  new URL("../recall-footprint-calibration-samples-summary.mjs", import.meta.url),
);

function makeRow(overrides = {}) {
  return {
    fillerPairs: 12,
    recallLimit: 20,
    turnCount: 26,
    totalInScope: 9,
    returnedCount: 9,
    mnemoraChars: 300,
    bandEntryCount: 0,
    rawIndex: { totalInScope: 9, groups: [], countKind: "exact" },
    rawIndexJsonLength: 40,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-25T00:00:00.000Z",
    commit: "abc123",
    llmMode: "recorded",
    embeddingMode: "recorded",
    designDecidedBeforeSeeingHoldOutErrors: true,
    rowCount: 1,
    rows: [makeRow()],
    ...overrides,
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
  workDir ??= mkdtempSync(join(tmpdir(), "recall-footprint-calibration-samples-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("recall-footprint-calibration-samples-summary.mjs(子プロセスで起動)", () => {
  it("--measured だけを渡すと exit 0 で、基準値が無いことを明示する", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("基準値ファイルが無い");
  });

  it("基準値と一致するときは exit 0 で「一致」と出す", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const baselinePath = writeJson("baseline.json", { rows: [makeRow()] });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✅ 基準値と一致");
  });

  it("🔴 基準値と相違するときも exit 0(門ではないことをここで固定する。ADR 0307 §2)", () => {
    const measuredPath = writeJson(
      "measured.json",
      makeMeasured({ rows: [makeRow({ mnemoraChars: 999 })] }),
    );
    const baselinePath = writeJson("baseline.json", { rows: [makeRow({ mnemoraChars: 300 })] });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mnemoraChars");
    expect(result.stdout).toContain("門ではない");
  });

  it("--measured を渡さないと非0", () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", "/nonexistent/path.json"]);
    expect(result.status).not.toBe(0);
  });

  it("--measured の中身が壊れた JSON(構文エラー)だと非0", () => {
    const measuredPath = writeJson("measured.json", "{ not json");
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
  });

  it("--measured の必須項目が無いと非0(壊れた入力=赤)", () => {
    const measured = makeMeasured();
    delete measured.rows[0].bandEntryCount;
    const measuredPath = writeJson("measured.json", measured);
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline を指定してそれが読めないと非0(baseline も「入力」である)", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath, "--baseline", "/nonexistent/baseline.json"]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の中身が壊れていると非0", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const baselinePath = writeJson("baseline.json", { rows: "not-an-array" });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status).not.toBe(0);
  });
});
