import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSummaryMarkdown } from "../compare-summary-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const script = fileURLToPath(new URL("../compare-summary.mjs", import.meta.url));

const NUMBER_FIELDS = [
  "fillerPairs",
  "turnCount",
  "naiveChars",
  "naiveTokens",
  "mnemoraChars",
  "mnemoraTokens",
  "mnemoraShareOfNaiveChars",
  "totalInScope",
  "returnedCount",
  "annCandidateCount",
];
const ROW_FIELDS = [...NUMBER_FIELDS, "factStatementSurvived", "omitted"];

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
    rows: [makeRow({ turnCount: 2, fillerPairs: 0 }), makeRow({ turnCount: 10 })],
    ...overrides,
  };
}

const without = (row, field) => {
  const { [field]: _dropped, ...rest } = row;
  return rest;
};

/** @type {string | undefined} */
let workDir;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "compare-summary-boundaries-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSyncWithDeadline(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("compare-summary.mjs: 欄が欠けた行は、門を黙って通さず入力の誤り（exit 1）にする", () => {
  const baseline = { rows: makeMeasured().rows };

  it.each(ROW_FIELDS)(
    "実測の行に %s が無ければ exit 1（判定不能の exit 2 でも緑でもない）",
    (field) => {
      const measured = makeMeasured({
        rows: [
          makeRow({ turnCount: 2, fillerPairs: 0 }),
          without(makeRow({ turnCount: 10 }), field),
        ],
      });
      const r = run([
        "--measured",
        writeJson("m.json", measured),
        "--baseline",
        writeJson("b.json", baseline),
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(field);
    },
  );

  it.each(ROW_FIELDS.filter((field) => field !== "turnCount"))(
    "基準値の行に %s が無ければ exit 1（比較できない基準値で緑にしない）",
    (field) => {
      const broken = {
        rows: [makeRow({ turnCount: 2, fillerPairs: 0 }), without(makeRow(), field)],
      };
      const r = run([
        "--measured",
        writeJson("m.json", makeMeasured()),
        "--baseline",
        writeJson("b.json", broken),
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(field);
    },
  );

  it.each(["llmMode", "embeddingMode"])("実測に %s が無ければ exit 1", (field) => {
    const measured = without(makeMeasured(), field);
    const r = run(["--measured", writeJson("m.json", measured)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(field);
  });
});

describe("compare-summary.mjs: 入力が壊れているときの終了コードは 1 で、判定不能の 2 と混ざらない", () => {
  const baseline = { rows: makeMeasured().rows };

  it("--measured のファイルが無ければ exit 1", () => {
    expect(run(["--measured", join(tmpdir(), "no-such-measured-0f3a9c.json")]).status).toBe(1);
  });

  it("--measured が JSON として読めなければ exit 1", () => {
    expect(run(["--measured", writeJson("m.json", "{not json")]).status).toBe(1);
  });

  it("--measured の形が壊れていれば exit 1", () => {
    expect(run(["--measured", writeJson("m.json", { rows: [] })]).status).toBe(1);
  });

  it("--baseline の形が壊れていれば exit 1", () => {
    const r = run([
      "--measured",
      writeJson("m.json", makeMeasured()),
      "--baseline",
      writeJson("b.json", { rows: "x" }),
    ]);
    expect(r.status).toBe(1);
  });

  it("入力が正しければ同じ組で exit 0（陰性対照）", () => {
    const r = run([
      "--measured",
      writeJson("m.json", makeMeasured()),
      "--baseline",
      writeJson("b.json", baseline),
    ]);
    expect(r.status).toBe(0);
  });
});

describe("buildSummaryMarkdown: 表の行", () => {
  it("mnemora/naive の比は百分率で小数1桁、冒頭の事実は✅/❌で出る", () => {
    const markdown = buildSummaryMarkdown({
      measured: makeMeasured({
        rows: [
          makeRow({ turnCount: 4, mnemoraShareOfNaiveChars: 0.5559, factStatementSurvived: false }),
        ],
      }),
    });
    expect(markdown).toContain("| 4 | 243 | 232 | 55.6% | 10 | 10 | 8 | ❌ |");
  });
});
