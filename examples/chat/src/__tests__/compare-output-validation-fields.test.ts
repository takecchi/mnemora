import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { formatRecallQualityTable, outputValidationFieldsFromRecall } from "../compare.js";
import type { ComparisonRow } from "../compare.js";
import { buildCompareJson } from "../compare-json.js";

/**
 * `ComparisonRow.outputValidationIssueCount` の導出を検査する（ADR 0551）。
 * **Postgres は要らない**——`outputValidationFieldsFromRecall` は `RecallResult` を渡すだけの
 * 純関数。`ok: false` の `RecallResult` は手で作る（core の `recall-output-validation.test.ts`
 * が `validateRecallOutput` で `ok: false` を作る先例に倣い、ここでは結果の形だけを直接組む）。
 */

function makeRecallResult(outputValidation?: RecallResult["outputValidation"]): RecallResult {
  return {
    recallId: "r1",
    memories: [],
    omitted: [],
    index: { groups: [], totalInScope: 0, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
    ...(outputValidation !== undefined ? { outputValidation } : {}),
  };
}

const ISSUES = [
  { path: "usage.estimatedTokens", code: "invalid_type", message: "a" },
  { path: "usage.chars", code: "invalid_type", message: "b" },
  { path: "index.totalInScope", code: "too_small", message: "c" },
];

function makeRow(overrides: Partial<ComparisonRow> = {}): ComparisonRow {
  return {
    fillerPairs: 1,
    turnCount: 4,
    naiveChars: 100,
    naiveTokens: 30,
    mnemoraChars: 40,
    mnemoraTokens: 12,
    mnemoraShareOfNaiveChars: 0.4,
    totalInScope: 3,
    omitted: [],
    returnedCount: 3,
    annCandidateCount: 3,
    bandEntryCount: 0,
    rawIndexJsonLength: 10,
    factStatementSurvived: true,
    memoryUsageReported: true,
    ...overrides,
  };
}

function toJson(rows: ComparisonRow[]) {
  return buildCompareJson({
    rows,
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    measuredAt: new Date("2026-10-03T00:00:00.000Z"),
    commit: null,
  });
}

describe("outputValidationFieldsFromRecall", () => {
  it("ok:true・issues:[] なら 0 件（欄は在る）", () => {
    const fields = outputValidationFieldsFromRecall(makeRecallResult({ ok: true, issues: [] }));
    expect(fields).toEqual({ outputValidationIssueCount: 0 });
  });

  it("ok:false で issues があれば、その件数", () => {
    const fields = outputValidationFieldsFromRecall(
      makeRecallResult({ ok: false, issues: ISSUES }),
    );
    expect(fields).toEqual({ outputValidationIssueCount: 3 });
  });

  it("outputValidation が undefined（off・未検証）なら欄を出さない（0 にしない）", () => {
    const fields = outputValidationFieldsFromRecall(makeRecallResult(undefined));
    expect(fields).toEqual({});
    expect("outputValidationIssueCount" in fields).toBe(false);
  });
});

describe("buildCompareJson — outputValidationIssueCount", () => {
  it("件数をそのまま写す。0 も欄として残る。未検証の行には欄そのものが無い。schemaVersion は 1 のまま", () => {
    const json = toJson([
      makeRow({ outputValidationIssueCount: 3 }),
      makeRow({ outputValidationIssueCount: 0 }),
      makeRow(),
    ]);
    expect(json.schemaVersion).toBe(1);
    expect(json.rows[0]!.outputValidationIssueCount).toBe(3);
    expect(json.rows[1]).toHaveProperty("outputValidationIssueCount", 0);
    expect("outputValidationIssueCount" in json.rows[2]!).toBe(false);
    // JSON 化しても未検証の行に欄が現れない
    expect(JSON.stringify(json.rows[2])).not.toContain("outputValidationIssueCount");
  });
});

describe("formatRecallQualityTable — 出力検査の違反件数列", () => {
  it("件数・0・未検証（—）を区別して出す", () => {
    const out = formatRecallQualityTable([
      makeRow({ turnCount: 11, outputValidationIssueCount: 2 }),
      makeRow({ turnCount: 12, outputValidationIssueCount: 0 }),
      makeRow({ turnCount: 13 }),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toContain("出力検査の違反件数");
    expect(lines[2]).toMatch(/\| 2 \|$/);
    expect(lines[3]).toMatch(/\| 0 \|$/);
    expect(lines[4]).toMatch(/\| — \|$/);
  });
});
