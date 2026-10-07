import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const script = fileURLToPath(new URL("../compare-summary.mjs", import.meta.url));

function makeRow(overrides = {}) {
  return {
    fillerPairs: 4,
    turnCount: 10,
    naiveChars: 243,
    naiveTokens: 120,
    mnemoraChars: 232,
    mnemoraTokens: 110,
    mnemoraShareOfNaiveChars: 232 / 243,
    totalInScope: 10,
    omitted: [],
    returnedCount: 8,
    annCandidateCount: 10,
    factStatementSurvived: true,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "abc123",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    rowCount: 2,
    rows: [makeRow({ turnCount: 2, fillerPairs: 0 }), makeRow({ turnCount: 10, fillerPairs: 4 })],
    ...overrides,
  };
}

function baselineFrom(measured) {
  return { rows: measured.rows.map((r) => structuredClone(r)) };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "compare-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args, options = {}) {
  return spawnSyncWithDeadline(process.execPath, [script, ...args], { encoding: "utf8", ...options });
}

describe("compare-summary.mjs（子プロセスで起動）", () => {
  it("--measured だけを渡すと exit 0 で、「基準値がまだ無い」旨を出す", () => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("## 基準値との差分");
    expect(result.stdout).toContain("基準値ファイルがまだ無い");
    expect(result.stdout).toContain("mnemora/naive");
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

  it("🔴 mnemoraShareOfNaiveChars が悪化(基準値より増加)したときは非0（⭐ 門。ADR 0133）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].mnemoraShareOfNaiveChars = 5; // 基準値より大きい ⟹ 悪化
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("相違した会話長が 1 件ある");
    expect(result.stderr).toContain("turnCount=2");
    expect(result.stderr).toContain("mnemoraShareOfNaiveChars");
  });

  it("🔴 factStatementSurvived が true→false に退行したときは非0（⭐ 門。ADR 0133）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("factStatementSurvived");
  });

  it("mnemoraShareOfNaiveChars が改善(基準値より減少)しただけなら exit 0", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].mnemoraShareOfNaiveChars = 0.01; // 基準値より小さい ⟹ 改善
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した会話長が 1 件ある");
  });

  it("退行の判定対象外の欄(naiveChars 等)だけが相違しても exit 0", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].naiveChars = 99999;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("naiveChars");
  });

  it("🔴【本題】基準値が1行だけなら exit 2（判定不能。緑にしない）", () => {
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars = 5; // turnCount=10 が退行している
    const baseline = { rows: [structuredClone(makeRow({ turnCount: 2, fillerPairs: 0 }))] };
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("判定不能");
    expect(result.stderr).toContain("turnCount=10");
    expect(result.stdout).toContain("この会話長は比較していない");
  });

  it("🔴【本題2】基準値が空配列なら exit 2（validateBaseline は通したままで落ちる）", () => {
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", { rows: [] }),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("1会話長も比較していない");
    expect(result.stderr).toContain("turnCount=2, 10");
  });

  it("🔴【測る点が減った側】基準値に在って実測に無い会話長が在れば exit 2", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured({ rows: [makeRow({ turnCount: 2, fillerPairs: 0 })] });
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("基準値に在って実測に無い");
    expect(result.stderr).toContain("turnCount=10");
  });

  it("🔴【退行の門は壊れていない】集合が一致して退行が在れば exit 1（exit 2 に混ぜない）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].mnemoraShareOfNaiveChars = 5;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("退行した");
  });

  it("【通したい側】集合が一致して退行が無ければ exit 0", () => {
    const measured = makeMeasured();
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baselineFrom(measured)),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("判定不能");
  });

  it("--measured を渡さないと非0", () => {
    expect(run([]).status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", join(tmpdir(), "does-not-exist-compare-12345.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/読めない/);
  });

  it("--measured の中身が壊れた JSON（構文エラー）だと非0", () => {
    const result = run(["--measured", writeJson("broken.json", "{ これは JSON ではない")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured に rows が無いと非0", () => {
    const result = run([
      "--measured",
      writeJson("no-rows.json", { llmMode: "deterministic", embeddingMode: "deterministic" }),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rows");
  });

  it("--baseline を指定してそれが読めないと非0（baseline も『入力』である）", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      join(tmpdir(), "does-not-exist-compare-baseline-12345.json"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の中身が壊れていると非0", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      writeJson("broken-baseline.json", "not json at all"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it.each([
    ["空の値", ["--baseline", ""]],
    ["値が無い（末尾）", ["--baseline"]],
  ])("🔴 --baseline が %s なら exit 1（⭐門を黙って外さない。Issue #1814）", (_label, tail) => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured()), ...tail]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--baseline");
  });

  it("🔴 --baseline の値の位置に次のフラグが来たら exit 1（Issue #1814）", () => {
    const result = run(["--baseline", "--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--baseline");
  });

  it.each([
    ["空の値", ["--measured", ""]],
    ["値が無い（末尾）", ["--measured"]],
  ])("--measured が %s なら exit 1（Issue #1814 の同じ形）", (_label, args) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--measured");
  });

  // 再確かめ（2026-10-07 マージ分、#1826）。使い方の行には --measured も --baseline も入っているので、
  // stderr のどこかに名前が在るだけでは、エラーの文がフラグを名乗らなくても通る。最初の行に限って見る。
  it.each([
    ["--baseline", ["--baseline", ""]],
    ["--measured", ["--measured", ""]],
  ])("%s が空のとき、エラーの文（最初の行）がそのフラグを名乗る（Issue #1814）", (flag, args) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr.split("\n")[0]).toContain(flag);
  });

  // 再確かめ（#1826）。弾くのは「次のフラグ（-- 始まり）」だけで、パスの途中の -- や、
  // 1本の - で始まる相対パスは、指定した値として読む。
  it("--baseline の値が途中に -- を含むパス・- 1本で始まる相対パスでも、指定した値として読む（Issue #1814）", () => {
    const measured = makeMeasured();
    const measuredPath = writeJson("measured.json", measured);
    mkdirSync(join(workDir, "a--b"));
    writeJson(join("a--b", "baseline.json"), baselineFrom(measured));
    writeJson("-baseline.json", baselineFrom(measured));
    for (const baseline of [join(workDir, "a--b", "baseline.json"), "-baseline.json"]) {
      const result = run(["--measured", measuredPath, "--baseline", baseline], { cwd: workDir });
      expect(result.status, `${baseline}: ${result.stderr}`).toBe(0);
      expect(result.stdout, baseline).toContain("## 基準値との差分");
    }
  });

  it("🔴 omitted だけが相違する入力でも exit 0 のままで、stderr に鮮度の警告が出る", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[1].omitted = [{ kind: "below_threshold", count: 1 }];
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("[compare-summary]");
    expect(result.stderr).toContain("基準値の鮮度");
    expect(result.stderr).toContain("turnCount=10");
    expect(result.stderr).toContain("omitted");
    expect(result.stderr).toContain("門ではない");
  });

  it("🔴 退行が在る入力でも exit 1 のままで、鮮度の警告も出ている(門は壊れていない)", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].mnemoraShareOfNaiveChars = 5; // 退行
    measured.rows[1].omitted = [{ kind: "below_threshold", count: 1 }]; // 鮮度だけの相違
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("退行した");
    expect(result.stderr).toContain("基準値の鮮度");
    expect(result.stderr).toContain("turnCount=10");
  });

  it("--baseline の rows に turnCount が無いと非0", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    delete baseline.rows[0].turnCount;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("turnCount");
  });
});
