import { describe, expect, it } from "vitest";
import type { MemoryStore, RecallResult, Runtime } from "@mnemora/core";
import {
  formatComparisonTable,
  formatRecallQualityTable,
  outputValidationFieldsFromRecall,
  runComparison,
} from "../compare.js";
import type { ComparisonRow } from "../compare.js";
import { buildCompareJson } from "../compare-json.js";

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

const ISSUES_SHARING_PATH = [
  { path: "usage.chars", code: "invalid_type", message: "a" },
  { path: "usage.chars", code: "too_small", message: "b" },
  { path: "index.totalInScope", code: "too_small", message: "c" },
];

function buildFakeRuntime(validations: Array<RecallResult["outputValidation"]>): Runtime {
  let pendingEmbedJobs = 0;
  let nextObserveId = 0;
  let recallCalls = 0;
  const observe: Runtime["observe"] = async () => {
    nextObserveId += 1;
    pendingEmbedJobs += 1;
    return {
      observationId: `obs-${nextObserveId}`,
      memoryIds: [`mem-observe-${nextObserveId}`],
      extraction: "ok",
      extractionFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["observe"]>>;
  };
  const tick: Runtime["tick"] = async () => {
    const processed = pendingEmbedJobs;
    pendingEmbedJobs = 0;
    return { processed, failed: 0, unsupported: [] } as unknown as Awaited<
      ReturnType<Runtime["tick"]>
    >;
  };
  const recall: Runtime["recall"] = async () => {
    const validation = validations[recallCalls];
    recallCalls += 1;
    return makeRecallResult(validation) as unknown as Awaited<ReturnType<Runtime["recall"]>>;
  };
  return { observe, tick, recall } as unknown as Runtime;
}

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

  it("同じ path に重なる issue も1件ずつ数える（path で畳まない）", () => {
    const fields = outputValidationFieldsFromRecall(
      makeRecallResult({ ok: false, issues: ISSUES_SHARING_PATH }),
    );
    expect(fields).toEqual({ outputValidationIssueCount: 3 });
  });

  it("outputValidation が undefined（off・未検証）なら欄を出さない（0 にしない）", () => {
    const fields = outputValidationFieldsFromRecall(makeRecallResult(undefined));
    expect(fields).toEqual({});
    expect("outputValidationIssueCount" in fields).toBe(false);
  });
});

describe("runComparison — 行に outputValidationIssueCount を写す", () => {
  it("検査した行には件数（0 を含む）が在り、未検証の行には欄そのものが無い", async () => {
    const rows = await runComparison(
      buildFakeRuntime([
        { ok: false, issues: ISSUES_SHARING_PATH },
        { ok: true, issues: [] },
        undefined,
      ]),
      { fillerPairsSequence: [0, 1, 2], memoryStore: {} as unknown as MemoryStore },
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveProperty("outputValidationIssueCount", 3);
    expect(rows[1]).toHaveProperty("outputValidationIssueCount", 0);
    expect("outputValidationIssueCount" in rows[2]!).toBe(false);
  });
});

describe("formatComparisonTable — 量だけの表には件数の列を足さない", () => {
  it("件数を持つ行でも、見出しにも本文にも違反件数の列が無い（6列のまま）", () => {
    const out = formatComparisonTable([
      makeRow({ turnCount: 11, outputValidationIssueCount: 2 }),
      makeRow({ turnCount: 12, outputValidationIssueCount: 0 }),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).not.toContain("出力検査");
    for (const line of lines) {
      expect(line.split("|").length - 2).toBe(6);
    }
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
