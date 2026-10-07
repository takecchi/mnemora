import type { CalibrationSampleRow } from "./recall-footprint-calibration-samples.js";
import type { ProviderMode } from "./providers.js";

/**
 * `recall-footprint-calibration-samples` の機械可読な出力口。ファイル I/O・環境変数・時刻取得を一切行わない純関数だけを置く。
 * 数字だけで条件を書かない出力は壊れるので、実際に使われた `llmMode`/`embeddingMode` を同居させる。
 * `compare-baseline.json`（門）の `rows` へは混ぜない——別ファイルとして CI artifact 化し、別途基準値へ昇格させる（ADR 0314 §2）。
 * `CalibrationSampleRow` をほぼそのまま写し、集計を作り直さない（`rawIndex` も丸ごと持つ）。
 */

export interface RecallFootprintCalibrationSampleJson {
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

export interface RecallFootprintCalibrationSamplesRunJson {
  schemaVersion: 1;
  measuredAt: string;
  commit: string | null;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** 標本の設計は hold-out の推定誤差を一度も見ずに決めた（コード上の事実）。`.dev.json` の同名キーと同じ主張を、CI 由来のこの JSON でも持たせる。 */
  designDecidedBeforeSeeingHoldOutErrors: true;
  rowCount: number;
  rows: RecallFootprintCalibrationSampleJson[];
}

export interface BuildRecallFootprintCalibrationSamplesJsonOptions {
  rows: readonly CalibrationSampleRow[];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  measuredAt: Date;
  commit: string | null;
}

/** 純関数。`measuredAt`/`commit` は呼び出し側が渡す。`row.rawIndex` は複製し、呼び出し側の以後の変更が影響しないようにする。 */
export function buildRecallFootprintCalibrationSamplesJson(
  options: BuildRecallFootprintCalibrationSamplesJsonOptions,
): RecallFootprintCalibrationSamplesRunJson {
  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    designDecidedBeforeSeeingHoldOutErrors: true,
    rowCount: options.rows.length,
    rows: options.rows.map((row) => ({
      fillerPairs: row.fillerPairs,
      recallLimit: row.recallLimit,
      turnCount: row.turnCount,
      totalInScope: row.totalInScope,
      returnedCount: row.returnedCount,
      mnemoraChars: row.mnemoraChars,
      bandEntryCount: row.bandEntryCount,
      rawIndex: JSON.parse(JSON.stringify(row.rawIndex)) as unknown,
      rawIndexJsonLength: row.rawIndexJsonLength,
    })),
  };
}
