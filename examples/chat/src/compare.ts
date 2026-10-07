import { footprintSampleFromRecall, heuristicTokenCounter, writeDecayClock } from "@mnemora/core";
import type {
  Ctx,
  DecayClock,
  MemoryStore,
  Omission,
  RecallAssociationQuery,
  RecallResult,
  Runtime,
  TenantSettingsStore,
} from "@mnemora/core";
import { buildConversation } from "./scenario.js";
import { measureNaive } from "./naive-path.js";
import { factStatementExternalId, reportMemoryUsage, runMnemoraPath } from "./mnemora-path.js";
import { resultContainsObservation } from "./provenance-trace.js";

/**
 * `recall().memories` が、冒頭の事実表明の出典に到達しているかを判定する。
 *
 * `sourceObservationId` を辿って `externalId` で照合するだけで、digest の中身は見ない。
 * 要約で答えの情報が失われていても、出典が同じなら true になる。情報が残ったことの証明ではない。
 * 文字列一致（`digest.includes`）に戻さないこと。実 LLM の要約・言い換えに耐えない。
 *
 * 返り値は `ComparisonRow.factStatementSurvived` として公開 JSON へそのまま写る。JSON のキー名は変えていない。
 */
async function factStatementSourceReached(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memories: readonly { memoryId: string }[],
): Promise<boolean> {
  return resultContainsObservation(memoryStore, ctx, memories, factStatementExternalId());
}

function notIndexedCount(omitted: Omission[]): number {
  return omitted
    .filter((o): o is Extract<Omission, { kind: "not_indexed" }> => o.kind === "not_indexed")
    .reduce((sum, o) => sum + o.count, 0);
}

/**
 * `ComparisonRow.bandEntryCount` / `ComparisonRow.rawIndexJsonLength` を `RecallResult` から計算する。
 * 純関数。Postgres なしで計算そのものを検査できるよう、`runComparison` から切り出してある。
 *
 * `bandEntryCount` は `footprintSampleFromRecall`（`@mnemora/core`）をそのまま呼ぶ。二重実装しない。
 */
export function footprintFieldsFromRecall(
  recall: RecallResult,
): Pick<ComparisonRow, "bandEntryCount" | "rawIndexJsonLength"> {
  const footprintSample = footprintSampleFromRecall(recall);
  return {
    bandEntryCount: footprintSample.bandEntryCount,
    rawIndexJsonLength: JSON.stringify(recall.index).length,
  };
}

/**
 * `ComparisonRow.outputValidationIssueCount` を `RecallResult` から導く純関数。
 *
 * `recall.outputValidation` が `undefined`（未検証）なら欄そのものを出さない（`{}` を返す）。
 * 未検証を「違反0件」と読ませないため。
 */
export function outputValidationFieldsFromRecall(
  recall: RecallResult,
): Pick<ComparisonRow, "outputValidationIssueCount"> {
  const validation = recall.outputValidation;
  if (validation === undefined) {
    return {};
  }
  return { outputValidationIssueCount: validation.issues.length };
}

/**
 * `compare` が測る会話の長さ（filler 往復数）の既定の列。
 * カセットの被覆を検査する歯（`cassette-coverage.test.ts`）が実 API の呼び出し回数を知る必要があり、`cli.ts` から移した。
 */
export const DEFAULT_COMPARE_SEQUENCE = [0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320];

export interface ComparisonRow {
  fillerPairs: number;
  turnCount: number;
  naiveChars: number;
  naiveTokens: number;
  mnemoraChars: number;
  mnemoraTokens: number;
  mnemoraShareOfNaiveChars: number;
  totalInScope: number;
  /**
   * `recall().omitted` をそのまま持つ（要約しない）。
   * `kind` だけにすると `reason`・`count`・`countKind` が消え、推定値を実測値の顔で出さない区別そのものが失われる。
   */
  omitted: Omission[];
  returnedCount: number;
  /**
   * スコープ内（`totalInScope`）のうち、実際に ANN の候補になれた件数（= totalInScope − `not_indexed` の合計）。
   * 「何件と競ったのか」に直接答える列。`not_indexed` の `countKind` が `exact` でなくても、引き算は count をそのまま差し引く。
   * 不確かさは `omitted` 列の `countKind` で確認する。
   */
  annCandidateCount: number;
  /**
   * `recall().index.digestBand?.length ?? 0`。`footprintSampleFromRecall` をそのまま呼んで導く（二重実装しない）。
   * `recall-footprint` の hold-in/hold-out の分け方を、`totalInScope <= DEFAULT_RECALL_LIMIT` という代理指標を介さず、この生の値で判定するため。
   */
  bandEntryCount: number;
  /**
   * `JSON.stringify(recall().index).length`。
   * `recall().index` そのものを毎行 commit すると `compare-baseline.json` が肥大化する。
   * 診断用の生データで門の判定には使わないため、JSON 化した長さだけを残す。
   */
  rawIndexJsonLength: number;
  /**
   * `recall().outputValidation.issues.length`。出力検査の違反件数。
   * 省略可能: 未検証のときは欄を出さない（0 と区別するため）。門・基準値・`DIFF_FIELDS` には入れない。
   */
  outputValidationIssueCount?: number;
  /**
   * 冒頭の事実表明の出典に、`recall().memories` が到達しているか。判定は `factStatementSourceReached` を見ること。
   *
   * 測っているのは出典への到達だけで、情報保持・最終回答の正誤は測っていない。
   *
   * 欄名（`factStatementSurvived`）は据え置いている。意味は「生存」ではなく「到達」だが、⭐門（ADR 0133）と
   * `examples/chat/compare-baseline.json` がこの名前を JSON のキーとして参照しており、改名は契約と検査を壊す。
   * 名前と意味のずれは、改名ではなくコメント・表示・文書で是正する（ADR 0226）。
   */
  factStatementSurvived: boolean;
  /**
   * この行の `recall()` で実際にプロンプトへ積んだ Memory を `observe({kind:'memory_usage'})` で報告したか。
   *
   * `compare-json.ts` の `buildCompareJson` はこの欄を写さない。`compare.json` のスキーマ（⭐門、ADR 0133）を変えないため。
   */
  memoryUsageReported: boolean;
  /**
   * `recall.memories` のうち `retrievedVia === "association"` だった件数。
   * `options.association` を省略した呼び出しは `queryRecall` 自身の既定（on）のままなので、0 より大きくなりうる。
   * 既定 off に固定した基準線ではなく、連想枠の既定 on が元々どれだけ効いていたかの実測。
   */
  associationRows?: number;
}

export interface CompareOptions {
  fillerPairsSequence: number[];
  tenantPrefix?: string;
  /**
   * 冒頭の事実の出典へ到達したかを `sourceObservationId` で辿るために必要。
   * 省略可能にしない。省略を許すと文字列一致へ倒れる経路が残り、どちらの判定で出た ❌ なのか表から読めなくなる。
   */
  memoryStore: MemoryStore;
  /**
   * `--decay-clock` が指定されたときだけ渡す。
   * `store`/`clock` を1つの欄にまとめるのは、片方だけ渡された不整合な状態を型で防ぐため。
   *
   * 省略時は `writeDecayClock` を一度も呼ばない。既定 `'wall'` のテナントで `tenant_settings` への書き込みが
   * 増えないことの唯一の保証点。
   */
  decayClock?: { store: TenantSettingsStore; clock: DecayClock };
  /**
   * `runMnemoraPath` へそのまま転送する `association`（測定専用オプション）。
   * 省略時は `queryRecall` 自身の既定（{@link DEFAULT_MNEMORA_PATH_ASSOCIATION}）のまま。
   * `compare` はこの既定でしか走ったことが無い。明示的に渡すのは `bench/association-default-on-measure.ts` だけ。
   */
  association?: RecallAssociationQuery | null;
}

/**
 * 会話の長さを変えて、経路A（naive）・経路B（mnemora）が実際に焼く量を測る。
 * budget は渡さない。切り詰めずに、そのままだと何文字になるかを見るため（計測と抑止を混同しない）。
 *
 * `fillerPairsSequence` の要素ごとに新しい tenantId を使う。同じテナントに積み増すと、
 * 後の計測が前の会話の記憶を引きずり、その長さの会話単体の量を独立に測れなくなる。
 */
export async function runComparison(
  runtime: Runtime,
  options: CompareOptions,
): Promise<ComparisonRow[]> {
  const tenantPrefix = options.tenantPrefix ?? "example-compare";
  const rows: ComparisonRow[] = [];
  for (const fillerPairs of options.fillerPairsSequence) {
    const ctx: Ctx = { tenantId: `${tenantPrefix}-${fillerPairs}` };
    if (options.decayClock !== undefined) {
      await writeDecayClock(options.decayClock.store, ctx, options.decayClock.clock);
    }
    const conversation = buildConversation(fillerPairs);
    const naive = measureNaive(conversation, heuristicTokenCounter);
    const { recall } = await runMnemoraPath(runtime, ctx, conversation, {
      association: options.association,
    });
    const survived = await factStatementSourceReached(options.memoryStore, ctx, recall.memories);

    // 使用報告は、この行の測定が終わった後に行う。`reportMemoryUsage` は recall を撃たないので測定値は変わらない。
    const usageReport = await reportMemoryUsage(runtime, ctx, recall);

    rows.push({
      fillerPairs,
      turnCount: conversation.turns.length,
      naiveChars: naive.chars,
      naiveTokens: naive.estimatedTokens,
      mnemoraChars: recall.usage.chars,
      mnemoraTokens: recall.usage.estimatedTokens,
      mnemoraShareOfNaiveChars: recall.usage.chars / naive.chars,
      totalInScope: recall.index.totalInScope,
      omitted: recall.omitted,
      returnedCount: recall.memories.length,
      annCandidateCount: recall.index.totalInScope - notIndexedCount(recall.omitted),
      ...footprintFieldsFromRecall(recall),
      ...outputValidationFieldsFromRecall(recall),
      factStatementSurvived: survived,
      memoryUsageReported: usageReport.reported,
      associationRows: recall.memories.filter((m) => m.retrievedVia === "association").length,
    });
  }
  return rows;
}

export function formatComparisonTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | naive chars | naive tokens(概算) | mnemora chars | mnemora tokens(概算) | mnemora/naive (chars) |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const ratio = `${(r.mnemoraShareOfNaiveChars * 100).toFixed(1)}%`;
    return `| ${r.turnCount} | ${r.naiveChars} | ${r.naiveTokens} | ${r.mnemoraChars} | ${r.mnemoraTokens} | ${ratio} |`;
  });
  return [header, sep, ...body].join("\n");
}

/** `omitted` を `kind(detail):count` の形にまとめた1行にする（件数を落とさない）。 */
function formatOmittedSummary(omitted: Omission[]): string {
  if (omitted.length === 0) {
    return "(無し)";
  }
  return omitted
    .map((o) => {
      switch (o.kind) {
        case "not_indexed":
          return `not_indexed(${o.reason}):${o.count}`;
        case "filtered":
          return `filtered(${o.condition}):${o.count}`;
        case "below_threshold":
          return `below_threshold:${o.count}`;
        case "over_limit":
          return `over_limit:${o.count}`;
        case "budget_dropped":
          return `budget_dropped:${o.count}`;
        case "stage_skipped":
          return `stage_skipped(${o.stage}/${o.reason})`;
        case "ann_truncated":
          return "ann_truncated";
        case "ann_unreached":
          return "ann_unreached";
        case "lexical_truncated":
          return "lexical_truncated";
        case "unit_assembly_dropped":
          return `unit_assembly_dropped:${o.count}`;
        case "score_not_comparable":
          return `score_not_comparable:${o.count}`;
        default: {
          // 網羅性の歯: Omission に新しい kind が増えたらここが型エラーになる。
          const exhaustive: never = o;
          return String(exhaustive);
        }
      }
    })
    .join(", ");
}

/**
 * 北極星の物差しに直接答える表。量だけの `formatComparisonTable` と違い、削っても目的の記憶の出典に
 * 到達できているかを並べる。「返った件数」と「ANN の候補になれた件数」を並べるのは、
 * `annCandidateCount` が `totalInScope` を下回ったとき、`omitted` 列の `not_indexed(pending):N` で内訳が読めるようにするため。
 *
 * 「到達したか」列が測るのは出典到達だけで、情報保持・最終回答の正誤は載っていない。
 */
export function formatRecallQualityTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | スコープ内の Memory | ANN の候補になれた件数 | 返った件数 | 冒頭の事実の出典に到達したか | `omitted` の内訳 | 出力検査の違反件数 |";
  const sep = "|---|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const survived = r.factStatementSurvived ? "✅" : "❌";
    // 未検証（欄なし）は「—」。0（検査して違反なし）と区別する。
    const violations =
      r.outputValidationIssueCount === undefined ? "—" : `${r.outputValidationIssueCount}`;
    return `| ${r.turnCount} | ${r.totalInScope} | ${r.annCandidateCount} | ${r.returnedCount} | ${survived} | ${formatOmittedSummary(r.omitted)} | ${violations} |`;
  });
  return [header, sep, ...body].join("\n");
}
