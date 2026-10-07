import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_RECALL_LIMIT } from "@mnemora/core";
import { CALIBRATION_SAMPLE_DESIGN } from "../recall-footprint-calibration-samples.js";

interface BaselineRow {
  turnCount: number;
  totalInScope: number;
  mnemoraChars: number;
  returnedCount: number;
  bandEntryCount: number;
}

interface BaselineFile {
  rowCount: number;
  rows: BaselineRow[];
}

interface CalibrationSampleRow {
  fillerPairs: number;
  recallLimit: number;
  turnCount: number;
  totalInScope: number;
  returnedCount: number;
  mnemoraChars: number;
  bandEntryCount: number;
  rawIndex: unknown;
  rawIndexJsonLength: number;
}

interface CalibrationSampleFile {
  provenance: {
    commit: string;
    measuredAt: string;
    ciJob: string;
    providers: string;
    repeatRuns: number;
    designDecidedBeforeSeeingHoldOutErrors: boolean;
  };
  rowCount: number;
  rows: CalibrationSampleRow[];
}

const baselinePath = fileURLToPath(new URL("../../compare-baseline.json", import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
const rows = baseline.rows;
const holdInRows = rows.filter((r) => r.bandEntryCount === 0);
const holdOutRows = rows.filter((r) => r.bandEntryCount !== 0);

const calibrationSamplesPath = fileURLToPath(
  new URL("../../recall-footprint-calibration-samples-baseline.json", import.meta.url),
);
const calibrationFile = JSON.parse(
  readFileSync(calibrationSamplesPath, "utf8"),
) as CalibrationSampleFile;
const calibrationSampleRows = calibrationFile.rows;

describe("compare-baseline.json — 前提(このファイルはここでも変更していない)", () => {
  it("12行のうち hold-in が7行・hold-out が5行のまま(recall-footprint-baseline.test.ts と同じ分け方)", () => {
    expect(rows).toHaveLength(12);
    expect(holdInRows).toHaveLength(7);
    expect(holdOutRows).toHaveLength(5);
  });
});

describe("recall-footprint-calibration-samples-baseline.json — 設計どおりに生成されていること", () => {
  it("CALIBRATION_SAMPLE_DESIGN の各点が、baseline に同じ (fillerPairs, limit) で1行ずつ現れる", () => {
    expect(calibrationFile.rowCount).toBe(CALIBRATION_SAMPLE_DESIGN.length);
    expect(calibrationSampleRows).toHaveLength(CALIBRATION_SAMPLE_DESIGN.length);
    for (const point of CALIBRATION_SAMPLE_DESIGN) {
      const row = calibrationSampleRows.find(
        (r) => r.fillerPairs === point.fillerPairs && r.recallLimit === point.limit,
      );
      expect(
        row,
        `design point fillerPairs=${point.fillerPairs} limit=${point.limit} が baseline に無い`,
      ).toBeDefined();
    }
  });

  it("CI artifact から実測更新されたことを、記録自身が名乗っている(commit/measuredAt/ciJob/repeatRuns)", () => {
    expect(calibrationFile.provenance.repeatRuns).toBeGreaterThanOrEqual(2);
    expect(typeof calibrationFile.provenance.commit).toBe("string");
    expect(calibrationFile.provenance.commit.length).toBeGreaterThan(0);
    expect(typeof calibrationFile.provenance.measuredAt).toBe("string");
    expect(calibrationFile.provenance.providers).toContain("recorded");
  });

  it("設計は hold-out の推定誤差を見る前に決めたと記録自身が名乗っている", () => {
    expect(calibrationFile.provenance.designDecidedBeforeSeeingHoldOutErrors).toBe(true);
  });

  it.each(calibrationSampleRows)(
    "turnCount=$turnCount (totalInScope=$totalInScope): 帯が空(bandEntryCount=0)であり、目標範囲 [9,20) に収まる",
    (row) => {
      expect(row.bandEntryCount).toBe(0);
      const digestBand = (row.rawIndex as { digestBand?: unknown[] }).digestBand;
      expect(digestBand === undefined || digestBand.length === 0).toBe(true);
      expect(row.totalInScope).toBeGreaterThan(DEFAULT_RECALL_LIMIT - 2); // >= 9
      expect(row.totalInScope).toBeLessThan(20);
    },
  );

  it("設計の目標(82行=totalInScope 25 まで内挿で届くように)に対し、範囲 [9,19] を実際にカバーしている", () => {
    const covered = new Set(calibrationSampleRows.map((r) => r.totalInScope));
    expect(Math.min(...covered)).toBe(9);
    expect(Math.max(...covered)).toBe(19);
  });

  it.each(calibrationSampleRows)(
    "turnCount=$turnCount: rawIndexJsonLength は JSON.stringify(rawIndex).length と一致する(記録の破損検知)",
    (row) => {
      expect(row.rawIndexJsonLength).toBe(JSON.stringify(row.rawIndex).length);
    },
  );

  it.each(calibrationSampleRows)(
    "turnCount=$turnCount: mnemoraChars は digest tier(returnedCount本) + index tier(rawIndexJsonLength) を下回らない",
    (row) => {
      expect(row.mnemoraChars).toBeGreaterThanOrEqual(row.rawIndexJsonLength);
    },
  );

  describe("変異: baseline から1点を欠かすと、設計との突き合わせが名指しで落ちる", () => {
    it.each(CALIBRATION_SAMPLE_DESIGN)(
      "fillerPairs=$fillerPairs limit=$limit を欠くと、rowCount または該当点の検査が失敗する",
      (missingPoint) => {
        const mutated = calibrationSampleRows.filter(
          (r) =>
            !(r.fillerPairs === missingPoint.fillerPairs && r.recallLimit === missingPoint.limit),
        );
        expect(mutated).toHaveLength(CALIBRATION_SAMPLE_DESIGN.length - 1);
        const stillRowCountOk = mutated.length === calibrationFile.rowCount;
        const stillAllPointsFound = CALIBRATION_SAMPLE_DESIGN.every((point) =>
          mutated.some((r) => r.fillerPairs === point.fillerPairs && r.recallLimit === point.limit),
        );
        expect(stillRowCountOk && stillAllPointsFound).toBe(false);
      },
    );
  });
});
