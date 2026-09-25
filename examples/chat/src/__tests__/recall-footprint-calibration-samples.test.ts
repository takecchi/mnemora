import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECALL_LIMIT,
  calibrateRecallFootprint,
  estimateRecallFootprint,
  type RecallFootprintSample,
} from "@mnemora/core";
import { CALIBRATION_SAMPLE_DESIGN } from "../recall-footprint-calibration-samples.js";

/**
 * Issue #340 案3(comment 5822837148 §4)の実現可能性検査 + 較正の補助標本の整合性検査。
 *
 * **DB も API キーも要らない**——`recall-footprint-calibration-samples.dev.json`
 * （`generateCalibrationSamples()` をローカルの recorded カセットに対して実行した記録、
 * ファイル冒頭の `_readme`/`provenance` 参照）と `compare-baseline.json`（⭐門、変更なし）
 * を読むだけである。
 *
 * ⚠ **`compare-baseline.json` の `rows`/`rowCount`/hold-in・hold-out の分け方
 * （`totalInScope <= DEFAULT_RECALL_LIMIT`）はここでも変更しない**
 * ——`recall-footprint-baseline.test.ts` が検査しているのと同じ12行・同じ分け方を、
 * そのまま読むだけである。`.dev.json` の8行は**別の変数**（`devSamples`）として
 * 足すのであって、`holdInRows`/`holdOutRows` の定義そのものは触らない。
 */

interface BaselineRow {
  turnCount: number;
  totalInScope: number;
  mnemoraChars: number;
  returnedCount: number;
}

interface BaselineFile {
  rowCount: number;
  rows: BaselineRow[];
}

interface DevSampleRow {
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

interface DevSampleFile {
  provenance: {
    reproducedLocally: boolean;
    localRunsMatched: number;
    designDecidedBeforeSeeingHoldOutErrors: boolean;
    llmMode: string;
    embeddingMode: string;
  };
  rowCount: number;
  rows: DevSampleRow[];
}

const baselinePath = fileURLToPath(new URL("../../compare-baseline.json", import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
const rows = baseline.rows;
const holdInRows = rows.filter((r) => r.totalInScope <= DEFAULT_RECALL_LIMIT);
const holdOutRows = rows.filter((r) => r.totalInScope > DEFAULT_RECALL_LIMIT);

const devSamplesPath = fileURLToPath(
  new URL("../../recall-footprint-calibration-samples.dev.json", import.meta.url),
);
const devFile = JSON.parse(readFileSync(devSamplesPath, "utf8")) as DevSampleFile;
const devSamples = devFile.rows;

function associationCountForRow(row: BaselineRow): number {
  const baseReturned = Math.min(DEFAULT_RECALL_LIMIT, row.totalInScope);
  return Math.max(0, row.returnedCount - baseReturned);
}

describe("compare-baseline.json — 前提(このファイルはここでも変更していない)", () => {
  it("12行のうち hold-in が7行・hold-out が5行のまま(recall-footprint-baseline.test.ts と同じ分け方)", () => {
    expect(rows).toHaveLength(12);
    expect(holdInRows).toHaveLength(7);
    expect(holdOutRows).toHaveLength(5);
  });
});

describe("recall-footprint-calibration-samples.dev.json — 設計どおりに生成されていること", () => {
  it("CALIBRATION_SAMPLE_DESIGN の各点が、dev.json に同じ (fillerPairs, limit) で1行ずつ現れる", () => {
    expect(devFile.rowCount).toBe(CALIBRATION_SAMPLE_DESIGN.length);
    expect(devSamples).toHaveLength(CALIBRATION_SAMPLE_DESIGN.length);
    for (const point of CALIBRATION_SAMPLE_DESIGN) {
      const row = devSamples.find(
        (r) => r.fillerPairs === point.fillerPairs && r.recallLimit === point.limit,
      );
      expect(
        row,
        `design point fillerPairs=${point.fillerPairs} limit=${point.limit} が dev.json に無い`,
      ).toBeDefined();
    }
  });

  it("ローカルで2回再現して一致したことを、記録自身が名乗っている(CI未検証であることも)", () => {
    expect(devFile.provenance.reproducedLocally).toBe(true);
    expect(devFile.provenance.localRunsMatched).toBeGreaterThanOrEqual(2);
    expect(devFile.provenance.llmMode).toBe("recorded");
    expect(devFile.provenance.embeddingMode).toBe("recorded");
  });

  it("設計は hold-out の推定誤差を見る前に決めたと記録自身が名乗っている", () => {
    expect(devFile.provenance.designDecidedBeforeSeeingHoldOutErrors).toBe(true);
  });

  it.each(devSamples)(
    "turnCount=$turnCount (totalInScope=$totalInScope): 帯が空(bandEntryCount=0)であり、目標範囲 [9,20) に収まる",
    (row) => {
      expect(row.bandEntryCount).toBe(0);
      // 自己宣言(bandEntryCount)だけでなく、生の index からも空であることを検算する
      // (`rawIndex.digestBand` が undefined または空配列であること)。
      const digestBand = (row.rawIndex as { digestBand?: unknown[] }).digestBand;
      expect(digestBand === undefined || digestBand.length === 0).toBe(true);
      expect(row.totalInScope).toBeGreaterThan(DEFAULT_RECALL_LIMIT - 2); // >= 9
      expect(row.totalInScope).toBeLessThan(20);
    },
  );

  it("設計の目標(82行=totalInScope 25 まで内挿で届くように)に対し、範囲 [9,19] を実際にカバーしている", () => {
    const covered = new Set(devSamples.map((r) => r.totalInScope));
    // 隣接する hold-in の最大(8, 22ターン行)から、82ターン行の totalInScope=25 まで
    // 埋まっているとは主張しない——実際に埋まった値だけを検査する(下の it が列挙)。
    expect(Math.min(...covered)).toBe(9);
    expect(Math.max(...covered)).toBe(19);
  });

  it.each(devSamples)(
    "turnCount=$turnCount: rawIndexJsonLength は JSON.stringify(rawIndex).length と一致する(記録の破損検知)",
    (row) => {
      expect(row.rawIndexJsonLength).toBe(JSON.stringify(row.rawIndex).length);
    },
  );

  it.each(devSamples)(
    "turnCount=$turnCount: mnemoraChars は digest tier(returnedCount本) + index tier(rawIndexJsonLength) を下回らない",
    (row) => {
      // usage.chars = Σdigest.length + JSON.stringify(indexBand).length（recall-runtime.ts）。
      // digest tier は0文字以上なので、index tier 単体が mnemoraChars の下限になる。
      expect(row.mnemoraChars).toBeGreaterThanOrEqual(row.rawIndexJsonLength);
    },
  );
});

describe("較正への影響(参考計算 — ⚠ recall-footprint-baseline.test.ts の歯はここでは動かさない)", () => {
  /**
   * ⚠ **この `describe` は ADR 0201/Issue #410 の⭐門(`recall-footprint-baseline.test.ts`)
   * ではない。** `ACCURACY_TOLERANCE`/`FLOOR_CHARS` はあちらのファイルにしか無く、
   * ここでは再定義しない——コピーすると2箇所が食い違う経路を作ってしまう
   * （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。ここでやるのは、
   * **この dev.json を較正標本に足すと何が起きるかを、同じ公開関数
   * （`calibrateRecallFootprint`/`estimateRecallFootprint`）で計算し、数値として
   * 記録する**ことだけである。この結果を歯として強制するかどうかは、Issue #340 の
   * 報告に委ねる(CI での実測・2回一致を経ていない dev.json を⭐門の入力にするのは、
   * `examples/chat/README.md` の compare-baseline.json 更新手順が求める規律に反する)。
   */
  const mainSamples: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const extendedSamples: RecallFootprintSample[] = [
    ...mainSamples,
    ...devSamples.map((row) => ({
      totalChars: row.mnemoraChars,
      memoryCount: row.returnedCount,
      bandEntryCount: row.bandEntryCount,
    })),
  ];

  it("拡張した標本(7+8=15点)は全点が bandEntryCount=0 として使える(calibrateRecallFootprint の対象になる)", () => {
    const mainProfile = calibrateRecallFootprint(mainSamples);
    const extendedProfile = calibrateRecallFootprint(extendedSamples);
    if (mainProfile.origin.kind !== "calibrated" || extendedProfile.origin.kind !== "calibrated") {
      throw new Error("unreachable");
    }
    expect(mainProfile.origin.sampleCount).toBe(7);
    expect(extendedProfile.origin.sampleCount).toBe(15);
    expect(extendedProfile.origin.borrowedFromDefault).toEqual([]);
  });

  it("【実測記録】拡張した係数での hold-out 5行の相対誤差は、既存の2.5%許容(ACCURACY_TOLERANCE)の内側に収まる", () => {
    const extendedProfile = calibrateRecallFootprint(extendedSamples);
    const errors = holdOutRows.map((row) => {
      const est = estimateRecallFootprint(
        { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
        extendedProfile,
      );
      return Math.abs(est.chars - row.mnemoraChars) / row.mnemoraChars;
    });
    const maxErr = Math.max(...errors);
    // 2026-09-25 実測: 拡張係数での12行全体の最大誤差は約2.11%(main単独では約1.56%)。
    // recall-footprint-baseline.test.ts の ACCURACY_TOLERANCE=0.025 の内側になお収まる。
    expect(maxErr).toBeLessThanOrEqual(0.025);
  });

  it("【実測記録・⚠ 現状は境界を割る】拡張した係数での字数の余白(半digest, ADR 0201 と同じ式)は、42ターン行で FLOOR を下回る", () => {
    const extendedProfile = calibrateRecallFootprint(extendedSamples);
    const TOLERANCE = 0.025; // recall-footprint-baseline.test.ts の ACCURACY_TOLERANCE と同じ値(コピーではなく値だけ揃えて検算)。
    const FLOOR_CHARS = extendedProfile.charsPerDigest / 2;

    const margins = holdOutRows.flatMap((row) => {
      const est = estimateRecallFootprint(
        { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
        extendedProfile,
      ).chars;
      const upperBoundChars = est / (1 - TOLERANCE);
      const lowerBoundChars = est / (1 + TOLERANCE);
      return [
        {
          turnCount: row.turnCount,
          direction: "upper" as const,
          marginChars: upperBoundChars - row.mnemoraChars,
        },
        {
          turnCount: row.turnCount,
          direction: "lower" as const,
          marginChars: row.mnemoraChars - lowerBoundChars,
        },
      ];
    });
    const narrowest = margins.reduce((min, cur) => (cur.marginChars < min.marginChars ? cur : min));

    // 2026-09-25 実測: turnCount=42(totalInScope=14) の下側で 7.68字。
    // main単独の係数では同じ行の余白は12.18字(緑)——標本を足すと係数(charsPerDigest)が
    // 15.458→16.336へ動き、FLOOR(半digest)も7.729→8.168へ一緒に動くため、
    // 「どちらも動く」計算をしないと見えない退行である。詳細は Issue #340 の報告。
    expect(narrowest.turnCount).toBe(42);
    expect(narrowest.direction).toBe("lower");
    expect(narrowest.marginChars).toBeLessThan(FLOOR_CHARS);
  });
});
