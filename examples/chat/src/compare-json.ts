import type { Omission } from "@mnemora/core";
import type { ComparisonRow } from "./compare.js";
import type { ProviderMode } from "./providers.js";

/**
 * `compare` の機械可読な出力口。ファイル I/O・環境変数・時刻取得を行わない純関数だけを置く。
 *
 * 数字だけを書いて条件を書かないベンチ出力は、この repo で実際に壊れている（ADR 0068・ADR 0081 §3.2）。
 * そのため、実際に使われた `llmMode`/`embeddingMode` をトップレベルに同居させる。
 *
 * `ComparisonRow` をほぼそのまま写す。集計をここで作り直さず、`omitted` も丸ごと持つ。
 */

export interface CompareRowJson {
  fillerPairs: number;
  turnCount: number;
  naiveChars: number;
  naiveTokens: number;
  mnemoraChars: number;
  mnemoraTokens: number;
  mnemoraShareOfNaiveChars: number;
  totalInScope: number;
  omitted: Omission[];
  returnedCount: number;
  annCandidateCount: number;
  /**
   * `ComparisonRow.bandEntryCount` をそのまま写す。省略可能欄にしたのは、`schemaVersion` を上げずに済ませるため。
   * 欄を持たない古い実測 JSON や `examples/chat/compare-baseline.json` が、summary スクリプトの検証を引き続き通る。
   */
  bandEntryCount?: number;
  /** `ComparisonRow.rawIndexJsonLength` をそのまま写す。省略可能にした理由は `bandEntryCount` と同じ。 */
  rawIndexJsonLength?: number;
  /**
   * `ComparisonRow.outputValidationIssueCount` をそのまま写す。欄が無い行は「検査していない」で、0 とは別。
   * 省略可能にした理由は `bandEntryCount` と同じ。門・基準値・`DIFF_FIELDS` には入れていない。
   */
  outputValidationIssueCount?: number;
  /**
   * 冒頭の事実表明の出典に到達したかだけを測る。情報保持・最終回答の正誤は含まれない。
   *
   * キー名は変えていない。⭐門（ADR 0133）と `examples/chat/compare-baseline.json` がこのキー名に依存しており、
   * `schemaVersion` を上げずに据え置くため。意味のずれは ADR 0226 で名乗る。
   */
  factStatementSurvived: boolean;
}

export interface CompareRunJson {
  /**
   * この形が変わったら上げる。読み手（summary スクリプト）が形の変化を検知できるように。
   * 既存の欄の意味を変えない追加（`bandEntryCount` など）では上げない。
   */
  schemaVersion: 1;
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない）。 */
  commit: string | null;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `rows.length`。件数をどこにも書き写さない。 */
  rowCount: number;
  rows: CompareRowJson[];
}

export interface BuildCompareJsonOptions {
  rows: readonly ComparisonRow[];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  measuredAt: Date;
  commit: string | null;
}

/**
 * `runComparison()` が返した `ComparisonRow[]` から、機械可読な JSON を組み立てる。
 *
 * 純関数にして、`measuredAt`/`commit` は呼び出し側が渡す。DB もネットワークも無い環境で検査できるため。
 * `row.omitted` は配列を複製して写し、呼び出し側の以後の変更が影響しないようにする。
 */
export function buildCompareJson(options: BuildCompareJsonOptions): CompareRunJson {
  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    rowCount: options.rows.length,
    rows: options.rows.map((row) => ({
      fillerPairs: row.fillerPairs,
      turnCount: row.turnCount,
      naiveChars: row.naiveChars,
      naiveTokens: row.naiveTokens,
      mnemoraChars: row.mnemoraChars,
      mnemoraTokens: row.mnemoraTokens,
      mnemoraShareOfNaiveChars: row.mnemoraShareOfNaiveChars,
      totalInScope: row.totalInScope,
      omitted: row.omitted.map((o) => ({ ...o })),
      returnedCount: row.returnedCount,
      annCandidateCount: row.annCandidateCount,
      bandEntryCount: row.bandEntryCount,
      rawIndexJsonLength: row.rawIndexJsonLength,
      ...(row.outputValidationIssueCount !== undefined
        ? { outputValidationIssueCount: row.outputValidationIssueCount }
        : {}),
      factStatementSurvived: row.factStatementSurvived,
    })),
  };
}
