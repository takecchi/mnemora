import type { Ctx, IndexBand, Runtime } from "@mnemora/core";
import { DEFAULT_RECALL_LIMIT } from "@mnemora/core";
import { ingestConversation, DEFAULT_MNEMORA_PATH_ASSOCIATION } from "./mnemora-path.js";
import { buildConversation } from "./scenario.js";

/**
 * recall-footprint の較正標本を、目次帯が空のまま件数が 10〜20 件の範囲まで増やす。
 *
 * `queryRecall` は `limit` を渡さず既定で頭打ちになるので、帯を空のまま保つには `RecallQuery.limit` を明示的に上げる必要がある。
 * `queryRecall` を拡張せず `runtime.recall` を直接呼ぶ（北極星の主測定の経路を、副次的な道具のために触らない）。
 * `limit` を上げても新しい embedding/LLM リクエストは増えず、`fillerPairs` が既定の列に無い値でも抽出プロンプトは
 * 記録済みの鍵に当たるので、実 API は叩かない。
 */

/**
 * 較正標本の設計。hold-out の推定誤差を一度も見ずに決めた。`fillerPairs` はカセットの被覆だけを基準に選んだ。
 * 20件ちょうどは掃引で到達しなかったが、無理に作らない（結果から逆算した基準になり、hold-out を見ずに決めた精神に反する）。
 */
export interface CalibrationSampleDesignPoint {
  fillerPairs: number;
  limit: number;
}

export const CALIBRATION_SAMPLE_DESIGN: readonly CalibrationSampleDesignPoint[] = [
  { fillerPairs: 12, limit: 20 },
  { fillerPairs: 13, limit: 20 },
  { fillerPairs: 16, limit: 20 },
  { fillerPairs: 17, limit: 20 },
  { fillerPairs: 19, limit: 20 },
  { fillerPairs: 21, limit: 20 },
  { fillerPairs: 25, limit: 20 },
  { fillerPairs: 29, limit: 20 },
];

/** テナントIDの接頭辞。`compare.ts` の `runComparison` と衝突しない値。 */
const TENANT_PREFIX = "recall-footprint-calib";

export interface CalibrationSampleRow {
  fillerPairs: number;
  recallLimit: number;
  turnCount: number;
  totalInScope: number;
  returnedCount: number;
  mnemoraChars: number;
  bandEntryCount: number;
  rawIndex: IndexBand;
  /** `rawIndex` から再計算できるが、記録が壊れていないかを歯で検査できるよう、計算元と計算結果を両方残す。 */
  rawIndexJsonLength: number;
}

/** `limit` をそのまま渡すだけで、`limit >= totalInScope` は検証しない。呼び出し側が `bandEntryCount === 0` を確認すること。 */
export async function recallFootprintCalibrationSample(
  runtime: Runtime,
  point: CalibrationSampleDesignPoint,
): Promise<CalibrationSampleRow> {
  const ctx: Ctx = { tenantId: `${TENANT_PREFIX}-${point.fillerPairs}-${point.limit}` };
  const conversation = buildConversation(point.fillerPairs);
  await ingestConversation(runtime, ctx, conversation);
  const recall = await runtime.recall(ctx, {
    text: conversation.query,
    limit: point.limit,
    association: DEFAULT_MNEMORA_PATH_ASSOCIATION,
  });
  const rawIndex = recall.index;
  return {
    fillerPairs: point.fillerPairs,
    recallLimit: point.limit,
    turnCount: conversation.turns.length,
    totalInScope: rawIndex.totalInScope,
    returnedCount: recall.memories.length,
    mnemoraChars: recall.usage.chars,
    bandEntryCount: rawIndex.digestBand?.length ?? 0,
    rawIndex,
    rawIndexJsonLength: JSON.stringify(rawIndex).length,
  };
}

export async function generateCalibrationSamples(
  runtime: Runtime,
  design: readonly CalibrationSampleDesignPoint[] = CALIBRATION_SAMPLE_DESIGN,
): Promise<CalibrationSampleRow[]> {
  const rows: CalibrationSampleRow[] = [];
  for (const point of design) {
    rows.push(await recallFootprintCalibrationSample(runtime, point));
  }
  return rows;
}

export { DEFAULT_RECALL_LIMIT };
