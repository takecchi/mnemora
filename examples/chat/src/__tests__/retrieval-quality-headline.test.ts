import { describe, expect, it } from "vitest";
import type { RecalledMemory, ScoreBreakdown } from "@mnemora/core";
import type { ArmReport, ProbeOutcome } from "../retrieval-quality.js";
import {
  armHeadline,
  computeDecayFreshnessRowwise,
  computeTermSpreads,
  formatArmSummaryTable,
} from "../retrieval-quality.js";

function memory(score: ScoreBreakdown): RecalledMemory {
  return {
    memoryId: `memory-${JSON.stringify(score)}`,
    digest: "d",
    retrievedVia: "ann",
    provenanceKind: "stated",
    score,
  };
}

function makeProbe(id: string, hit1: boolean, hit10: boolean): ProbeOutcome {
  const goldRank = !hit10 ? null : hit1 ? 1 : 2;
  return {
    probeId: id,
    lexicalControl: false,
    goldRank,
    distractorRank: null,
    hit1,
    hit10,
    distractorBeatsGold: false,
    reciprocalRank: goldRank === null ? 0 : 1 / goldRank,
    omittedKinds: [],
    totalInScope: 74,
    scoreDetails: [],
    termSpreads: [],
    recalledRows: 10,
    lexicalMatchRows: 0,
    decayFreshnessRowwise: { rows: 0, equalRows: 0, differentRows: 0 },
  };
}

function makeArmReport(armLabel: string, probes: ProbeOutcome[], mrrOverall: number): ArmReport {
  return {
    armLabel,
    tenantId: `tenant-${armLabel}`,
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    ingest: {
      observationCount: 74,
      drain: { ticks: 2, totalProcessed: 74, totalFailed: 0, firstTickProcessed: 50 },
      extractionCounts: { ok: 74, skipped: 0, llmFailedWholeObservation: 0 },
      measurement: "measured",
      singleTickWouldHaveStalled: true,
    },
    probes,
    mrrOverall,
    mrrLexicalControl: 0.123,
    mrrNonLexical: 0.456,
    usageReport: "(usage)",
    channels: ["ann"],
  };
}

const armA = makeArmReport(
  "A",
  Array.from({ length: 7 }, (_, i) => makeProbe(`p${i}`, true, true)),
  1.0,
);

const armB = makeArmReport(
  "B",
  Array.from({ length: 7 }, (_, i) => makeProbe(`p${i}`, false, false)),
  0.0,
);

const armC = makeArmReport(
  "C",
  [
    makeProbe("p0", true, true),
    makeProbe("p1", true, true),
    makeProbe("p2", true, true),
    makeProbe("p3", true, true),
    makeProbe("p4", false, true),
    makeProbe("p5", false, true),
    makeProbe("p6", false, false),
  ],
  0.714,
);

function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

describe("formatArmSummaryTable — arm を跨いで数字が混ざらない（ADR 0068 ②-1・②-2）", () => {
  const table = formatArmSummaryTable([armA, armB, armC]);
  const lines = table.split("\n");
  const header = parseTableRow(lines[0]!);
  const armIdx = header.indexOf("arm");
  const mrrIdx = header.indexOf("MRR(全体)");
  const hit1Idx = header.indexOf("hit@1");
  const hit10Idx = header.indexOf("hit@10");
  const dataRows = lines.slice(2).map(parseTableRow);
  const rowFor = (label: string): string[] => {
    const row = dataRows.find((r) => r[armIdx] === label);
    if (!row) {
      throw new Error(`arm ${label} の行が見つからない: ${table}`);
    }
    return row;
  };

  it("②-2: MRR・hit@1・hit@10 の3列がすべて存在する(別の表へ行く理由が無い)", () => {
    expect(armIdx).toBeGreaterThanOrEqual(0);
    expect(mrrIdx).toBeGreaterThanOrEqual(0);
    expect(hit1Idx).toBeGreaterThanOrEqual(0);
    expect(hit10Idx).toBeGreaterThanOrEqual(0);
  });

  it("②-1: 各行が自分の arm の数字だけを含む(全部 hit の arm A)", () => {
    const row = rowFor("A");
    expect(row[mrrIdx]).toBe("1.000");
    expect(row[hit1Idx]).toBe("7/7");
    expect(row[hit10Idx]).toBe("7/7");
  });

  it("②-1: 各行が自分の arm の数字だけを含む(全部外す arm B)", () => {
    const row = rowFor("B");
    expect(row[mrrIdx]).toBe("0.000");
    expect(row[hit1Idx]).toBe("0/7");
    expect(row[hit10Idx]).toBe("0/7");
  });

  it("②-1: 各行が自分の arm の数字だけを含む(混在の arm C — B の 0/7 も A の 7/7 も出ない)", () => {
    const row = rowFor("C");
    expect(row[mrrIdx]).toBe("0.714");
    expect(row[hit1Idx]).toBe("4/7");
    expect(row[hit10Idx]).toBe("6/7");
  });
});

describe("armHeadline — ArmReport を1つだけ受け取り、probes からのみ導く（ADR 0068 ②-3）", () => {
  it("hit1Count/hit10Count/probeCount は probes の実カウントと一致する", () => {
    const headline = armHeadline(armC);
    expect(headline.hit1Count).toBe(armC.probes.filter((p) => p.hit1).length);
    expect(headline.hit10Count).toBe(armC.probes.filter((p) => p.hit10).length);
    expect(headline.probeCount).toBe(armC.probes.length);
    expect(headline.mrrOverall).toBe(armC.mrrOverall);
  });

  it("mrrLexicalControl/mrrNonLexical は見ない(probes と mrrOverall だけから導く)", () => {
    const tweaked: ArmReport = { ...armC, mrrLexicalControl: 999, mrrNonLexical: -999 };
    expect(armHeadline(tweaked)).toEqual(armHeadline(armC));
  });

  it("引数は ArmReport 1つだけ——別の arm を渡さない限り、別の arm の数字は混ざりようがない", () => {
    expect(armHeadline(armA)).not.toEqual(armHeadline(armB));
    expect(armHeadline(armA).hit1Count).toBe(7);
    expect(armHeadline(armB).hit1Count).toBe(0);
  });

  it("recalledRows/lexicalMatchRows は probes の同名欄の総和(ADR 0108)", () => {
    const probes: ProbeOutcome[] = [
      { ...makeProbe("p0", true, true), recalledRows: 10, lexicalMatchRows: 2 },
      { ...makeProbe("p1", true, true), recalledRows: 10, lexicalMatchRows: 0 },
    ];
    const report = makeArmReport("Z", probes, 1.0);
    const headline = armHeadline(report);
    expect(headline.recalledRows).toBe(20);
    expect(headline.lexicalMatchRows).toBe(2);
  });

  it("termDistinct は probes の termSpreads から、項ごとの何通りかを arm 単位で集計する", () => {
    const memoriesP0 = [
      memory({ similarity: 0.5, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.5 }),
      memory({ similarity: 0.3, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.3 }),
    ];
    const memoriesP1 = [
      memory({ similarity: 0.9, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.9 }),
      memory({ similarity: 0.1, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.1 }),
    ];
    const probes: ProbeOutcome[] = [
      {
        ...makeProbe("p0", true, true),
        termSpreads: computeTermSpreads(memoriesP0),
        decayFreshnessRowwise: computeDecayFreshnessRowwise(memoriesP0),
      },
      {
        ...makeProbe("p1", true, true),
        termSpreads: computeTermSpreads(memoriesP1),
        decayFreshnessRowwise: computeDecayFreshnessRowwise(memoriesP1),
      },
    ];
    const headline = armHeadline(makeArmReport("Z", probes, 1.0));

    const similarity = headline.termDistinct.find((t) => t.term === "similarity")!;
    expect(similarity.presentRows).toBe(4);
    expect(similarity.minDistinctPerProbe).toBe(2);
    expect(similarity.maxDistinctPerProbe).toBe(2);
    expect(similarity.min).toBe(0.1);
    expect(similarity.max).toBe(0.9);

    const tagMatch = headline.termDistinct.find((t) => t.term === "tagMatch")!;
    expect(tagMatch.presentRows).toBe(4);
    expect(tagMatch.minDistinctPerProbe).toBe(1);
    expect(tagMatch.maxDistinctPerProbe).toBe(1);
    expect(tagMatch.min).toBe(1);
    expect(tagMatch.max).toBe(1);

    expect(headline.decayFreshnessEqualRows).toBe(4);
    expect(headline.decayFreshnessDifferentRows).toBe(0);
  });

  it("termSpreads を持たない(空配列の)probe しか無ければ、その項は presentRows=0・min/max=null になる", () => {
    const headline = armHeadline(armA);
    for (const t of headline.termDistinct) {
      expect(t.presentRows).toBe(0);
      expect(t.min).toBeNull();
      expect(t.max).toBeNull();
    }
  });
});
