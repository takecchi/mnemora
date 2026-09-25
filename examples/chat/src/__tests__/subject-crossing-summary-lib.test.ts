import { describe, expect, it } from "vitest";
import {
  parseRawFile,
  renderMarkdownReport,
  summarizeTrials,
} from "../subject-crossing-summary-lib.js";
import type { TrialResult } from "../subject-crossing-measure.js";

function trial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    s: 2,
    n: 5,
    pole: "disjoint",
    minAffinity: 0.8,
    ctxVariant: "none",
    seedId: "seed-1",
    seedSubjectId: "subject-0",
    eligibleCount: 2,
    eligibleSubjectCount: 1,
    mixed: false,
    ...overrides,
  };
}

describe("summarizeTrials", () => {
  it("同じ pole/s/n/ctxVariant/minAffinity の試行を1グループに集約する", () => {
    const rows = summarizeTrials([
      trial({ seedId: "a" }),
      trial({ seedId: "b" }),
      trial({ s: 5, seedId: "c" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("eligibleCount < 2 の試行は trialsWithCandidates から除く(1件を『統合』とは呼ばない)", () => {
    const rows = summarizeTrials([
      trial({ eligibleCount: 1, eligibleSubjectCount: 1, mixed: false }),
      trial({ eligibleCount: 2, eligibleSubjectCount: 2, mixed: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalTrials).toBe(2);
    expect(rows[0]!.trialsWithCandidates).toBe(1);
    expect(rows[0]!.mixedCount).toBe(1);
    expect(rows[0]!.mixedRateAmongCandidates).toBe(1);
  });

  it("trialsWithCandidates が0のとき mixedRateAmongCandidates は null(0/0 を0%と書かない)", () => {
    const rows = summarizeTrials([
      trial({ eligibleCount: 0, eligibleSubjectCount: 0, mixed: false }),
    ]);
    expect(rows[0]!.trialsWithCandidates).toBe(0);
    expect(rows[0]!.mixedRateAmongCandidates).toBeNull();
  });

  it("own ctx は構造的に mixed=false のはず——集約もそれを素通しする(新しい判定を作らない)", () => {
    const rows = summarizeTrials([
      trial({ ctxVariant: "own", eligibleCount: 3, eligibleSubjectCount: 1, mixed: false }),
      trial({ ctxVariant: "own", eligibleCount: 4, eligibleSubjectCount: 1, mixed: false }),
    ]);
    expect(rows[0]!.mixedRateAmongCandidates).toBe(0);
  });
});

describe("renderMarkdownReport", () => {
  it("N×S の表をセルごとに mixedRate(n=候補/全体) の形で出す", () => {
    const rows = summarizeTrials([
      trial({ s: 2, n: 5, eligibleCount: 2, eligibleSubjectCount: 2, mixed: true }),
      trial({ s: 10, n: 5, eligibleCount: 2, eligibleSubjectCount: 1, mixed: false }),
    ]);
    const md = renderMarkdownReport(rows);
    expect(md).toContain("## pole=disjoint ctx.subjectId=none minAffinity=0.8");
    expect(md).toContain("| N=5 | 100% (n=1/1) | 0% (n=1/1) |");
  });

  it("空の rows でも例外を投げず、見出しだけの文字列を返す", () => {
    expect(() => renderMarkdownReport([])).not.toThrow();
    expect(renderMarkdownReport([])).toContain("Issue #579");
  });
});

describe("parseRawFile", () => {
  it("results 配列を持つ妥当な JSON を受け取る", () => {
    const parsed = parseRawFile(JSON.stringify({ commit: "abc", measuredAt: "now", results: [] }));
    expect(parsed.ok).toBe(true);
  });

  it("JSON として読めない入力は ok:false で理由を返す(黙って空扱いしない)", () => {
    const parsed = parseRawFile("{not json");
    expect(parsed.ok).toBe(false);
  });

  it("results 配列が無い入力は ok:false で理由を返す", () => {
    const parsed = parseRawFile(JSON.stringify({ commit: "abc" }));
    expect(parsed.ok).toBe(false);
  });
});
