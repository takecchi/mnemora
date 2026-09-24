import { describe, expect, it } from "vitest";
import type { LexicalCandidateRow } from "../lexical-tie-density-lib.js";
import {
  groupTiesByScore,
  measureTieDensityFromRows,
  renderTieDensityReport,
} from "../lexical-tie-density-lib.js";

function row(memoryId: string, coverage: number, rank: number): LexicalCandidateRow {
  return { memoryId, coverage, rank };
}

describe("groupTiesByScore", () => {
  it("空配列には何も返さない", () => {
    expect(groupTiesByScore([])).toEqual([]);
  });

  it("全行が異なる (coverage, rank) なら、1行ずつのグループになる", () => {
    const rows = [row("a", 1, 0.5), row("b", 0.5, 0.9), row("c", 0.5, 0.1)];
    const groups = groupTiesByScore(rows);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1]);
  });

  it("連続する同値行を1つのグループにまとめる（Issue #394 本文の再現: 400件同点）", () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(`m${i}`, 1, 0.16666667));
    const groups = groupTiesByScore(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      coverage: 1,
      rank: 0.16666667,
      count: 400,
      startIndex: 0,
      endIndex: 399,
    });
  });

  it("同値でない行を挟むと、タイ集団は分かれる（連続区間のみをまとめる）", () => {
    const rows = [row("a", 1, 0.5), row("b", 1, 0.5), row("c", 0.8, 0.5), row("d", 1, 0.5)];
    const groups = groupTiesByScore(rows);
    // 前提が「rows は事前にソート済み」であるこの関数は、非隣接の同値を統合しない
    // （ORDER BY が既に同値を隣接させているはずであり、統合しないことがその前提の
    // 検査にもなる——もし本体の ORDER BY が壊れて同値が離れて出た場合、ここで
    // グループ数が増えて見え、静かに握り潰さない）。
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1]);
  });
});

describe("measureTieDensityFromRows", () => {
  it("候補が limit 以下なら、LIMIT は何も切り詰めていない（truncatedWithinTie は false）", () => {
    const rows = [row("a", 1, 0.5), row("b", 1, 0.5)];
    const m = measureTieDensityFromRows("q", "query", 10, rows);
    expect(m.totalCandidates).toBe(2);
    expect(m.boundaryGroup).toBeUndefined();
    expect(m.truncatedWithinTie).toBe(false);
  });

  it("候補0件（Issue #394 が測る対象の日本語 probe と同じ形）は、タイの主張を一切しない", () => {
    const m = measureTieDensityFromRows("probe:color", "query", 40, []);
    expect(m.totalCandidates).toBe(0);
    expect(m.tieGroups).toEqual([]);
    expect(m.truncatedWithinTie).toBe(false);
  });

  it("Issue #394 本文の再現: 400件同点・LIMIT 50 → タイ集団の途中で切れる", () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(`m${i}`, 1, 0.16666667));
    const m = measureTieDensityFromRows("obsidian-repro", "obsidian shards", 50, rows);
    expect(m.totalCandidates).toBe(400);
    expect(m.tieGroups).toHaveLength(1);
    expect(m.boundaryGroup).toMatchObject({ count: 400, startIndex: 0, endIndex: 399 });
    expect(m.truncatedWithinTie).toBe(true);
  });

  it("タイ集団がちょうど limit で終わる場合は、分断していない", () => {
    // 先頭5件が同値、6件目以降は別値。limit=5 だと、ぴったりタイ集団の終わりで切れる。
    const rows = [
      row("a", 1, 0.5),
      row("b", 1, 0.5),
      row("c", 1, 0.5),
      row("d", 1, 0.5),
      row("e", 1, 0.5),
      row("f", 0.5, 0.5),
    ];
    const m = measureTieDensityFromRows("q", "query", 5, rows);
    expect(m.boundaryGroup).toMatchObject({ count: 5, startIndex: 0, endIndex: 4 });
    expect(m.truncatedWithinTie).toBe(false);
  });

  it("陽性対照の形（5件同点・LIMIT 3）: 道具が実際にタイの分断を検出できる", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`c${i}`, 1, 0.42));
    const m = measureTieDensityFromRows("control", "quartz lantern", 3, rows);
    expect(m.truncatedWithinTie).toBe(true);
    expect(m.boundaryGroup?.count).toBe(5);
  });
});

describe("renderTieDensityReport", () => {
  it("空の測定結果でも見出し行だけの表を返す（例外にしない）", () => {
    const report = renderTieDensityReport([]);
    expect(report).toContain("| label | query |");
  });

  it("タイが分断された行に 🔴 を出す。分断していない行には出さない", () => {
    const truncated = measureTieDensityFromRows(
      "obsidian-repro",
      "obsidian shards",
      50,
      Array.from({ length: 400 }, (_, i) => row(`m${i}`, 1, 0.16666667)),
    );
    const notTruncated = measureTieDensityFromRows("probe:color", "query", 40, []);
    const report = renderTieDensityReport([truncated, notTruncated]);
    const lines = report.split("\n");
    const truncatedLine = lines.find((l) => l.includes("obsidian-repro"));
    const notTruncatedLine = lines.find((l) => l.includes("probe:color"));
    expect(truncatedLine).toContain("🔴 はい");
    expect(notTruncatedLine).toContain("n/a（LIMIT未到達）");
  });
});
