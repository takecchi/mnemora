import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_RECALL_FOOTPRINT_PROFILE,
  DEFAULT_RECALL_LIMIT,
  calibrateRecallFootprint,
  compareWithFullLog,
  estimateRecallFootprint,
  type RecallFootprintSample,
} from "@mnemora/core";

// compare-baseline.json は CI の門なので書き換えない。hold-in/hold-out は代理指標 totalInScope ではなく bandEntryCount === 0 で分ける。limit を上げる呼び出しで代理指標は崩れる（ADR 0314）。

interface BaselineRow {
  turnCount: number;
  totalInScope: number;
  naiveChars: number;
  mnemoraChars: number;
  mnemoraShareOfNaiveChars: number;
  returnedCount: number;
  bandEntryCount: number;
}

interface BaselineFile {
  rowCount: number;
  rows: BaselineRow[];
}

const baselinePath = fileURLToPath(new URL("../../compare-baseline.json", import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
const rows = baseline.rows;

interface CalibrationSampleBaselineRow {
  fillerPairs: number;
  recallLimit: number;
  turnCount: number;
  totalInScope: number;
  returnedCount: number;
  mnemoraChars: number;
  bandEntryCount: number;
}

interface CalibrationSampleBaselineFile {
  rowCount: number;
  rows: CalibrationSampleBaselineRow[];
}

const calibrationSamplesPath = fileURLToPath(
  new URL("../../recall-footprint-calibration-samples-baseline.json", import.meta.url),
);
const calibrationSamplesFile = JSON.parse(
  readFileSync(calibrationSamplesPath, "utf8"),
) as CalibrationSampleBaselineFile;
const calibrationSampleRows = calibrationSamplesFile.rows;

function associationCountForRow(row: BaselineRow): number {
  const baseReturned = Math.min(DEFAULT_RECALL_LIMIT, row.totalInScope);
  return Math.max(0, row.returnedCount - baseReturned);
}

/** 許容誤差 0.025 は通すために緩めない（Issue #340・#410・ADR 0166 が却下）。実測ぎりぎりにも置かない（丸めで揺れる）。 */
const ACCURACY_TOLERANCE = 0.025;

/** 欄が無い行は、黙って 0 や旧条件へ倒さず名指しで失敗する（欄が失われたとき黙って緑にならないため）。 */
function bandEntryCountOrThrow(row: BaselineRow): number {
  if (typeof row.bandEntryCount !== "number") {
    throw new Error(
      `compare-baseline.json の turnCount=${row.turnCount} 行に bandEntryCount が無い。` +
        "hold-in/hold-out の分け方は bandEntryCount === 0 である(Issue #340 フォローアップ・" +
        "ADR 0314)。基準値が壊れている可能性があるので、CI artifact から作り直すこと" +
        "(examples/chat/README.md『基準値を更新する手順』)。",
    );
  }
  return row.bandEntryCount;
}

const holdInRows = rows.filter((r) => bandEntryCountOrThrow(r) === 0);
const holdOutRows = rows.filter((r) => bandEntryCountOrThrow(r) !== 0);

/** totalInScope を渡す。渡さないと構造項が0扱いになり、桁上がり分が係数へ吸い込まれる（ADR 0306）。 */
const calibrationSamples: RecallFootprintSample[] = [
  ...holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
    totalInScope: row.totalInScope,
  })),
  ...calibrationSampleRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: row.bandEntryCount,
    totalInScope: row.totalInScope,
  })),
];

function relativeError(estimatedChars: number, actualChars: number): number {
  return Math.abs(estimatedChars - actualChars) / actualChars;
}

describe("compare-baseline.json — 前提（行数が変わっていないこと）", () => {
  it("12行のうち、目次帯が空の(bandEntryCount === 0)行が7行、そうでない行が5行", () => {
    expect(rows).toHaveLength(12);
    expect(holdInRows).toHaveLength(7);
    expect(holdOutRows).toHaveLength(5);
  });
});

describe("hold-in/hold-out の分け方の移行 — bandEntryCount === 0 と旧条件(totalInScope <= DEFAULT_RECALL_LIMIT)が1行も違わない（Issue #340 フォローアップ、ADR 0314）", () => {
  it.each(rows)(
    "turnCount=$turnCount: bandEntryCount===0 と totalInScope<=DEFAULT_RECALL_LIMIT の判定が一致する",
    (row) => {
      expect(bandEntryCountOrThrow(row) === 0).toBe(row.totalInScope <= DEFAULT_RECALL_LIMIT);
    },
  );
});

describe("calibrateRecallFootprint — 7点だけ(拡張前)の較正は変更前の値に一致し続ける", () => {
  const samples: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const calibrated = calibrateRecallFootprint(samples);

  it("borrowedFromDefault が空(7行に memoryCount の広がりがあるため両係数とも決まる)、sampleCount=7", () => {
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);
    expect(calibrated.origin.sampleCount).toBe(7);
  });

  it("較正した係数が変更前の値(charsPerDigest≒15.458 / fixedIndexChars≒170.881)に一致する", () => {
    expect(calibrated.charsPerDigest).toBeCloseTo(15.458, 2);
    expect(calibrated.fixedIndexChars).toBeCloseTo(170.881, 2);
  });
});

describe("calibrateRecallFootprint — hold-in 15行(7+8)での較正", () => {
  const calibrated = calibrateRecallFootprint(calibrationSamples);

  it("borrowedFromDefault が空(15行に memoryCount の広がりがあるため両係数とも決まる)、sampleCount=15", () => {
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);
    expect(calibrated.origin.sampleCount).toBe(15);
  });

  it("較正した係数が BUILTIN_RECALL_FOOTPRINT_PROFILE の新しい値(charsPerDigest≒16.175 / fixedIndexChars≒168.503)に一致する", () => {
    expect(calibrated.charsPerDigest).toBeCloseTo(
      BUILTIN_RECALL_FOOTPRINT_PROFILE.charsPerDigest,
      2,
    );
    expect(calibrated.fixedIndexChars).toBeCloseTo(
      BUILTIN_RECALL_FOOTPRINT_PROFILE.fixedIndexChars,
      2,
    );
  });

  describe("較正済みプロファイルで12行すべての mnemoraChars を予測する", () => {
    it.each(holdOutRows)(
      "hold-out: turnCount=$turnCount (totalInScope=$totalInScope) の誤差が許容誤差以内",
      (row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          calibrated,
        );
        const err = relativeError(est.chars, row.mnemoraChars);
        expect(err).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
      },
    );

    it("12行全体(較正に使った7行 + hold-outの5行。較正標本自体は7+8=15点)の最大誤差が許容誤差以内", () => {
      const errors = rows.map((row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          calibrated,
        );
        return relativeError(est.chars, row.mnemoraChars);
      });
      const maxErr = Math.max(...errors);
      expect(maxErr).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
    });
  });

  const TOO_CLOSE_TO_CALL_TURN_COUNTS = new Set<number>([10]);

  describe("compareWithFullLog — 12行すべてで判定の向きが実測と一致する(too_close_to_callは除く)", () => {
    it.each(rows)(
      "turnCount=$turnCount (totalInScope=$totalInScope, 実測share=$mnemoraShareOfNaiveChars)",
      (row) => {
        const result = compareWithFullLog({
          fullLogChars: row.naiveChars,
          shape: {
            memoryCountInScope: row.totalInScope,
            associationCount: associationCountForRow(row),
          },
          profile: calibrated,
        });

        if (TOO_CLOSE_TO_CALL_TURN_COUNTS.has(row.turnCount)) {
          expect(result.verdict).toBe("too_close_to_call");
          return;
        }

        const expectedDirection =
          row.mnemoraShareOfNaiveChars < 1 ? "mnemora_smaller" : "full_log_smaller";
        expect(result.verdict).toBe(expectedDirection);
      },
    );

    it("8ターン行(totalInScope=3, naiveChars=197, 実測109.6%)は1に近いが許容誤差の外なので full_log_smaller のまま", () => {
      const row = rows.find((r) => r.turnCount === 8);
      if (!row) throw new Error("baseline row not found: turnCount=8");
      const result = compareWithFullLog({
        fullLogChars: row.naiveChars,
        shape: {
          memoryCountInScope: row.totalInScope,
          associationCount: associationCountForRow(row),
        },
        profile: calibrated,
      });
      expect(result.verdict).toBe("full_log_smaller");
    });
  });
});

describe("BUILTIN_RECALL_FOOTPRINT_PROFILE（既定プロファイル）でも同じ12行を予測する", () => {
  it("既定プロファイルの最大誤差が許容誤差以内であり、hold-in較正(15点)とほぼ同程度に当たる", () => {
    const calibrated = calibrateRecallFootprint(calibrationSamples);

    const maxErrDefault = Math.max(
      ...rows.map((row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          BUILTIN_RECALL_FOOTPRINT_PROFILE,
        );
        return relativeError(est.chars, row.mnemoraChars);
      }),
    );
    const maxErrCalibrated = Math.max(
      ...rows.map((row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          calibrated,
        );
        return relativeError(est.chars, row.mnemoraChars);
      }),
    );

    expect(maxErrDefault).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
    expect(Math.abs(maxErrDefault - maxErrCalibrated)).toBeLessThan(0.005);
  });
});

/** 対象は hold-out だけ。較正標本は calibrateRecallFootprint の入力そのもので、実測が動くと係数も動くため、較正を固定した余白を計算できない（ADR 0201）。FLOOR は余白の実測値を固定しない（正当な変更のたびに赤くなる）。 */
describe("字数で見た誤差の余白 — hold-out 5行のうちいちばん狭い行を明示する(Issue #410、較正標本15点、ADR 0306/0310)", () => {
  const calibrated = calibrateRecallFootprint(calibrationSamples);

  interface MarginInfo {
    turnCount: number;
    direction: "upper" | "lower";
    marginChars: number;
  }

  const margins: MarginInfo[] = holdOutRows.flatMap((row): MarginInfo[] => {
    const est = estimateRecallFootprint(
      { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
      calibrated,
    ).chars;
    const upperBoundChars = est / (1 - ACCURACY_TOLERANCE);
    const lowerBoundChars = est / (1 + ACCURACY_TOLERANCE);
    return [
      {
        turnCount: row.turnCount,
        direction: "upper",
        marginChars: upperBoundChars - row.mnemoraChars,
      },
      {
        turnCount: row.turnCount,
        direction: "lower",
        marginChars: row.mnemoraChars - lowerBoundChars,
      },
    ];
  });

  const narrowest = margins.reduce((min, cur) => (cur.marginChars < min.marginChars ? cur : min));

  const FLOOR_CHARS = calibrated.charsPerDigest / 2;

  it(
    `いちばん余白が狭いのは turnCount=${narrowest.turnCount}(${narrowest.direction}側)で ` +
      `${narrowest.marginChars.toFixed(2)}字 — 半digest分(${FLOOR_CHARS.toFixed(2)}字)を上回ること`,
    () => {
      expect(narrowest.marginChars).toBeGreaterThanOrEqual(FLOOR_CHARS);
    },
  );
});

describe("calibrateRecallFootprint — totalInScope を渡しても、hold-in 7行(すべて1桁)では係数がバイト単位で変わらない（Issue #340 フォローアップ / ADR 0306）", () => {
  const samplesWithout: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const samplesWith: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
    totalInScope: row.totalInScope,
  }));

  it("hold-in 7行がすべて1桁であること（この歯の前提。桁上がりが起きない形であることを検算する）", () => {
    for (const row of holdInRows) {
      expect(row.totalInScope, `turnCount=${row.turnCount}`).toBeLessThanOrEqual(9);
    }
  });

  it("charsPerDigest / fixedIndexChars とも Object.is で完全一致する（totalInScope の有無で1バイトも変わらない）", () => {
    const withoutProfile = calibrateRecallFootprint(samplesWithout);
    const withProfile = calibrateRecallFootprint(samplesWith);
    expect(Object.is(withProfile.charsPerDigest, withoutProfile.charsPerDigest)).toBe(true);
    expect(Object.is(withProfile.fixedIndexChars, withoutProfile.fixedIndexChars)).toBe(true);
    expect(withProfile.charsPerDigest).toBeCloseTo(15.458, 2);
    expect(withProfile.fixedIndexChars).toBeCloseTo(170.881, 2);
  });
});
