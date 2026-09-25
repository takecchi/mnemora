import type { CalibrationSampleRow } from "./recall-footprint-calibration-samples.js";
import type { ProviderMode } from "./providers.js";

/**
 * `recall-footprint-calibration-samples`（Issue #340 フォローアップ、ADR 0313）の
 * 機械可読な出力口。
 *
 * `./compare-json.ts`（ADR 0133）・`./time-term-json.ts`（ADR 0058/#217）と同じ分担:
 * ファイル I/O・環境変数・時刻取得を一切行わない純関数だけを置く。`cli.ts` の
 * `runRecallFootprintCalibrationSamples()` が `generateCalibrationSamples()`
 * （`recall-footprint-calibration-samples.ts`）の返り値（`CalibrationSampleRow[]`）を
 * ここへ渡して JSON を組み立て、`MNEMORA_RECALL_FOOTPRINT_CALIBRATION_SAMPLES_JSON` が
 * 設定されているときだけ書き出す。
 *
 * 🔴 **数字だけを書いて、条件を書かないベンチ出力は、この repo で実際に3度壊れている**
 * （ADR 0068・ADR 0081 §3.2）。だからこの JSON も、**実際に使われた** `llmMode`/
 * `embeddingMode`（`handle` の実値）をトップレベルに同居させる。
 *
 * ⚠ **これは `compare-baseline.json`（⭐門、ADR 0133）とは別物である。**
 * `examples/chat/README.md`「`recall-footprint-calibration-samples.dev.json`」節・
 * ADR 0313 §2 の決定どおり、この出力を `compare-baseline.json` の `rows` へ混ぜない
 * ——別ファイルとして CI artifact 化し、`compare-baseline.json` と同じ手順
 * （CI artifact・2回以上一致）で別途基準値へ昇格させる。
 *
 * ⚠ **`CalibrationSampleRow` をほぼそのまま写す。**集計をここで作り直さない
 * ——`rawIndex`（`IndexBand`、生の記録）も丸ごと持つ（Issue #340 comment 5822837148 §4
 * の2番「切片のずれが構造の問題か digest 長の問題かを切り分けられない」を埋める）。
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
  /** この形が変わったら上げる。読み手（summary スクリプト）が形の変化を検知できるように。 */
  schemaVersion: 1;
  /** ISO 8601。JSON を組み立てた時刻——8点すべての生成が終わった後。 */
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない。`./git-info.js` 参照）。 */
  commit: string | null;
  /** その run で**実際に**使われたモード（`handle.llmMode`/`handle.embeddingMode` の実値）。 */
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /**
   * 標本の設計（`CALIBRATION_SAMPLE_DESIGN`）は hold-out
   * （`compare-baseline.json` の5行）の推定誤差を一度も見ずに決めた——
   * `recall-footprint-calibration-samples.ts` 冒頭の doc・`CALIBRATION_SAMPLE_DESIGN`
   * 自身の doc に記録済みの、コード上の事実（測定ごとに変わらない）。
   * `.dev.json` の `provenance.designDecidedBeforeSeeingHoldOutErrors` と同じ主張を、
   * CI 由来のこの JSON でも同じキー名で持たせる。
   */
  designDecidedBeforeSeeingHoldOutErrors: true;
  /** `rows.length`。件数をどこにも書き写さない（ADR 0068 の再発防止と同じ規律）。 */
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

/**
 * `generateCalibrationSamples()` が返した `CalibrationSampleRow[]` から、
 * 機械可読な JSON を組み立てる。
 *
 * **純関数**（ファイル I/O・環境変数・時刻取得を一切行わない）——呼び出し側が
 * `measuredAt`/`commit` を明示的に渡す。これにより DB もネットワークも無い環境で
 * 検査できる（`__tests__/recall-footprint-calibration-samples-json.test.ts`）。
 *
 * **出所は `CalibrationSampleRow` の欄だけ**（`compare-json.ts`/`time-term-json.ts` と
 * 同じ規律）。集計をここで作り直さない——`row.rawIndex` を丸ごと写す
 * （`JSON.parse(JSON.stringify(...))` で複製し、呼び出し側の以後の変更が影響しない
 * ようにする——`compare-json.ts` が `omitted` 配列にしているのと同じ配慮）。
 */
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
