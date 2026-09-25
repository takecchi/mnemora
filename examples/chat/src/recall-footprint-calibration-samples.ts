import type { Ctx, IndexBand, Runtime } from "@mnemora/core";
import { DEFAULT_RECALL_LIMIT } from "@mnemora/core";
import { ingestConversation, DEFAULT_MNEMORA_PATH_ASSOCIATION } from "./mnemora-path.js";
import { buildConversation } from "./scenario.js";

/**
 * Issue #340 案3（comment 5822837148 §4）: recall-footprint の較正標本を、
 * **目次帯が空のまま件数が 10〜20 件**の範囲まで増やす。
 *
 * ## なぜこのファイルが要るか
 *
 * `examples/chat/compare-baseline.json` の hold-in 行（`recall-footprint-baseline.test.ts`
 * の `holdInRows`）は `totalInScope <= DEFAULT_RECALL_LIMIT`（=10）の7行しかなく、
 * 目次帯が空のまま返る最大件数は `totalInScope=8`（22ターン行）に留まる。82ターン行
 * （`totalInScope=25`）まで内挿で届く較正をするには、**目次帯が空のまま件数が
 * 10〜20件になる標本**が要る（Issue #340 コメント §4 の1番）。
 *
 * `runMnemoraPath`/`queryRecall`（`mnemora-path.ts`）は `RecallQuery.limit` を渡さない
 * ため既定の {@link DEFAULT_RECALL_LIMIT}（10）で頭打ちになり、`totalInScope` が
 * それを超えるconversationは必ず目次帯を持つ。**帯を空のまま保つには、
 * `RecallQuery.limit`（`packages/core` の既存の公開フィールド）を明示的に上げて、
 * `limit >= totalInScope` にする必要がある**——これは `queryRecall` を拡張せず、
 * `runtime.recall` を直接呼ぶ形で行う（`compare.ts`/`probe-set.ts`/`scenario.ts`/
 * `naive-path.ts` は一切変更しない。`scope.ts`/`backfill.ts`/`correction-demo.ts` と
 * 同じ規律——北極星の主測定の経路を、副次的な道具のために触らない）。
 *
 * ## 実 API を叩かない（実測で確認済み）
 *
 * `buildConversation(fillerPairs)` は `FACT_STATEMENT` と12行の filler（`scenario.ts`）を
 * 順に繰り返すだけで、`fillerPairs` の値には依存しない固定の文面しか使わない。
 * `buildExtractionPrompt`（`packages/core/src/extraction.ts`）は観測1件のテキストだけで
 * 決まり（`extractionContext` を渡さない `ingestConversation` の呼び方では会話全体の
 * 文脈も渡らない）、`llmCassetteKey` は `PromptSpec` のハッシュ——⟹ **`fillerPairs` が
 * `examples/chat/README.md` の `DEFAULT_COMPARE_SEQUENCE`（`compare.ts`）に無い値でも、
 * 使うテキストが同じ12行+事実表明の閉じた集合である限り、抽出プロンプトは必ず
 * 記録済みの鍵に当たる。**
 *
 * `recall()` が呼ぶ provider は埋め込みだけ（`packages/core/src/recall-runtime.ts`）——
 * クエリ文（`QUERY_TEXT`、`fillerPairs` に依らず固定）の埋め込み1回だけであり、
 * 連想枠（`association`）は `VectorStore.getVectors`/`search` しか呼ばない
 * （embeddingProvider.embed は呼ばない）。⟹ **`limit` を上げても新しい embedding/LLM
 * リクエストは1つも増えない。**
 *
 * 【実測、2026-09-25、ローカル Postgres 17 + pgvector、`examples/chat/cassettes/compare.json`
 * の再生】上の主張を、実際に `RecordedEmbeddingProvider`/`RecordedLLMProvider`
 * （カセットに無い入力では例外を投げる、`packages/testkit`）に対して以下の
 * {@link CALIBRATION_SAMPLE_DESIGN} を含む fillerPairs=6〜642 の広い掃引で実行し、
 * 一度も「記録に無い」例外が出ないことを確認した。同じ設計を2回独立に ingest
 * （毎回新しい `tenantId`）して実行し、`rawIndex`/`mnemoraChars` を含む全行が
 * バイト単位で一致した。
 */

/**
 * 較正標本の設計。**hold-out（compare-baseline.json の5行）の推定誤差を一度も見ずに
 * 決めた**（決定の時点はこのファイルの最初のコミット。決めた根拠はコメント参照）。
 *
 * - `limit: 20` — 丸い数（`DEFAULT_RECALL_LIMIT` の2倍）であり、Issue #340 コメントが
 *   名指しした「10〜20件」の上限に一致する。
 * - `fillerPairs` の各値は、**カセットの被覆だけ**を基準に選んだ——`limit=20` の下で
 *   `totalInScope`（=目次帯が空のときの返る件数）が新しい整数値に達する最小の
 *   `fillerPairs` を、9件から19件まで掃引して拾った（実測手順は Issue #340 対応の
 *   報告を参照。ここでは値だけを固定する）。20件ちょうどはこの掃引では
 *   到達しなかった（次に到達したのは21件、範囲外）——**無理に20件を作らない**
 *   （20件に最も近い `fillerPairs` を無理に選ぶと、その選択自体が「範囲に収めたい」
 *   という結果から逆算した基準になり、上の「hold-outを見ずに決めた」の精神に反する）。
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

/** テナントIDの接頭辞。`compare.ts` の `runComparison`（`example-compare-`）と衝突しない値。 */
const TENANT_PREFIX = "recall-footprint-calib";

export interface CalibrationSampleRow {
  fillerPairs: number;
  recallLimit: number;
  turnCount: number;
  totalInScope: number;
  returnedCount: number;
  mnemoraChars: number;
  bandEntryCount: number;
  /**
   * `RecallResult.index` をそのまま持つ（Issue #340 コメント §4 の2番: 切片のずれが
   * 構造の問題か digest 長の問題かを、後から `groups`/`countKind` 等の生の値で
   * 切り分けられるようにする）。
   */
  rawIndex: IndexBand;
  /**
   * `JSON.stringify(rawIndex).length`。`usage.chars` のうち index tier の実際の寄与を
   * 後から検算するための冗長な記録（`rawIndex` から再計算できるが、記録が壊れて
   * いないかを歯で検査できるように、計算元と計算結果を両方残す）。
   */
  rawIndexJsonLength: number;
}

/**
 * 1点の設計に対して ingest + recall を行い、較正標本1行を作る。
 *
 * `limit >= totalInScope` を狙う設計だが、これは事前の掃引で確かめた期待であり、
 * この関数自身は `limit` をそのまま渡すだけで検証はしない——呼び出し側
 * （このファイルの `generateCalibrationSamples` / 検査する歯）が
 * `bandEntryCount === 0` を確認すること。
 */
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

/** {@link CALIBRATION_SAMPLE_DESIGN} の全点を順に生成する。 */
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

// re-export for callers that only need the threshold used in the design comment above.
export { DEFAULT_RECALL_LIMIT };
