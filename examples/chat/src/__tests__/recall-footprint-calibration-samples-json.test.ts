import { describe, expect, it } from "vitest";
import type { IndexBand } from "@mnemora/core";
import { buildRecallFootprintCalibrationSamplesJson } from "../recall-footprint-calibration-samples-json.js";
import type { CalibrationSampleRow } from "../recall-footprint-calibration-samples.js";

/**
 * Issue #340 フォローアップ（ADR 0313）: `recall-footprint-calibration-samples-json.ts` の
 * 出力口。DB もネットワークも要らない（純関数）。
 *
 * ⭐ **最重要の検査**: `CalibrationSampleRow[]` をそのまま写していること（集計を
 * 作り直さない）、`rawIndex` を丸ごと保持すること（`compare-json.ts` の `omitted` と
 * 同じ理由）、`compare-baseline.json`（⭐門）のスキーマを一切変えていないこと
 * （このファイルはそちらのテストではない——別ファイル用の出力口である）。
 */

function makeIndex(overrides: Partial<IndexBand> = {}): IndexBand {
  return {
    groups: [],
    totalInScope: 12,
    countKind: "exact",
    ...overrides,
  };
}

function makeRow(overrides: Partial<CalibrationSampleRow> = {}): CalibrationSampleRow {
  const rawIndex = makeIndex();
  return {
    fillerPairs: 12,
    recallLimit: 20,
    turnCount: 26,
    totalInScope: 12,
    returnedCount: 12,
    mnemoraChars: 300,
    bandEntryCount: 0,
    rawIndex,
    rawIndexJsonLength: JSON.stringify(rawIndex).length,
    ...overrides,
  };
}

describe("buildRecallFootprintCalibrationSamplesJson", () => {
  it("schemaVersion/measuredAt/commit/llmMode/embeddingMode をトップレベルに持つ(実際に使われた値)", () => {
    const json = buildRecallFootprintCalibrationSamplesJson({
      rows: [makeRow()],
      llmMode: "recorded",
      embeddingMode: "recorded",
      measuredAt: new Date("2026-09-25T01:00:00.000Z"),
      commit: "abc123",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.measuredAt).toBe("2026-09-25T01:00:00.000Z");
    expect(json.commit).toBe("abc123");
    expect(json.llmMode).toBe("recorded");
    expect(json.embeddingMode).toBe("recorded");
  });

  it("commit が null なら null のまま書く(推測で埋めない)", () => {
    const json = buildRecallFootprintCalibrationSamplesJson({
      rows: [makeRow()],
      llmMode: "recorded",
      embeddingMode: "recorded",
      measuredAt: new Date("2026-09-25T01:00:00.000Z"),
      commit: null,
    });
    expect(json.commit).toBeNull();
  });

  it("rowCount は rows.length から導く(書き写さない)", () => {
    const json = buildRecallFootprintCalibrationSamplesJson({
      rows: [
        makeRow({ fillerPairs: 12 }),
        makeRow({ fillerPairs: 13 }),
        makeRow({ fillerPairs: 16 }),
      ],
      llmMode: "recorded",
      embeddingMode: "recorded",
      measuredAt: new Date("2026-09-25T01:00:00.000Z"),
      commit: null,
    });
    expect(json.rowCount).toBe(3);
    expect(json.rows).toHaveLength(3);
  });

  it("designDecidedBeforeSeeingHoldOutErrors は常に true(コード上の設計事実)", () => {
    const json = buildRecallFootprintCalibrationSamplesJson({
      rows: [],
      llmMode: "recorded",
      embeddingMode: "recorded",
      measuredAt: new Date("2026-09-25T01:00:00.000Z"),
      commit: null,
    });
    expect(json.designDecidedBeforeSeeingHoldOutErrors).toBe(true);
  });

  it("row の全欄をそのまま写す(rawIndex を含む)", () => {
    const rawIndex = makeIndex({
      totalInScope: 19,
      digestBand: [],
    });
    const row = makeRow({
      fillerPairs: 19,
      recallLimit: 20,
      turnCount: 40,
      totalInScope: 19,
      returnedCount: 19,
      mnemoraChars: 987,
      bandEntryCount: 0,
      rawIndex,
      rawIndexJsonLength: JSON.stringify(rawIndex).length,
    });
    const json = buildRecallFootprintCalibrationSamplesJson({
      rows: [row],
      llmMode: "recorded",
      embeddingMode: "recorded",
      measuredAt: new Date("2026-09-25T01:00:00.000Z"),
      commit: null,
    });
    const written = json.rows[0]!;
    expect(written.fillerPairs).toBe(19);
    expect(written.recallLimit).toBe(20);
    expect(written.turnCount).toBe(40);
    expect(written.totalInScope).toBe(19);
    expect(written.returnedCount).toBe(19);
    expect(written.mnemoraChars).toBe(987);
    expect(written.bandEntryCount).toBe(0);
    expect(written.rawIndex).toEqual(rawIndex);
    expect(written.rawIndexJsonLength).toBe(JSON.stringify(rawIndex).length);
  });

  it("呼び出し側の row.rawIndex への後からの変更が、組み立てた JSON に影響しない(複製している)", () => {
    const rawIndex = makeIndex({ digestBand: [] });
    const row = makeRow({ rawIndex });
    const json = buildRecallFootprintCalibrationSamplesJson({
      rows: [row],
      llmMode: "recorded",
      embeddingMode: "recorded",
      measuredAt: new Date("2026-09-25T01:00:00.000Z"),
      commit: null,
    });
    (rawIndex.digestBand as unknown[]).push({ mutated: true });
    expect((json.rows[0]!.rawIndex as { digestBand: unknown[] }).digestBand).toEqual([]);
  });

  it("rows が空配列でも落ちない(rowCount は 0)", () => {
    const json = buildRecallFootprintCalibrationSamplesJson({
      rows: [],
      llmMode: "recorded",
      embeddingMode: "recorded",
      measuredAt: new Date("2026-09-25T01:00:00.000Z"),
      commit: null,
    });
    expect(json.rowCount).toBe(0);
    expect(json.rows).toEqual([]);
  });
});
