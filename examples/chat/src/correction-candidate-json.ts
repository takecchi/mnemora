import type {
  CorrectionCandidateReport,
  CorrectionCandidateSummary,
} from "./correction-candidate-arm.js";
import type { MarginStats } from "./identifier-arm.js";
import type { ProviderMode } from "./providers.js";

/**
 * `correction-candidates` の機械可読な出力口（`./identifier-json.js`/
 * `./numeral-token-json.js` と同じ作法。ADR 0291 §7-3、ADR 0321）。
 *
 * ⛔ **`./identifier-json.js`/`./numeral-token-json.js` とは別ファイル**（既存の
 * 識別子・数詞索引 probe の出力口・基準値には一切触れていない）。
 *
 * 🔴 **「重みを取得できなかった」と「測ったが値が悪かった」を型で区別する**
 * （`status` の判別union、既存2つの json 出力口と同じ理由）。
 *
 * **群は1つだけ**（`hits`/`abstains` を同じ run の中に持つ。sparse/dense のような
 * haystack 条件の分岐がこの arm には無い——`correction-candidate-arm.ts` の
 * doc コメントの通り、この bench は「1本の会話へ ingest → ケースごとに recall()」
 * という単一条件である）。
 *
 * **`marginStats`/`intrusionMarginStats` を持つ**（ADR 0291 §5.5 の核心）。
 */

export interface CorrectionCandidateEmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

export interface CorrectionCandidateHitJson {
  caseId: string;
  goldRank: number | null;
  distractorRank: number | null;
  distractorBeatsGold: boolean;
  goldScore: number | null;
  margin: number | null;
}

export interface CorrectionCandidateAbstainJson {
  caseId: string;
  kind: string;
  protectedAtTop: boolean;
  abstained: boolean;
  topScore: number | null;
  protectedFactScore: number | null;
  intrusionMargin: number | null;
}

export interface CorrectionCandidateSummaryJson {
  hitCount: number;
  /** k(1/3/5/10)ごとの当たった件数。JSON のキーは文字列になる（`"1"`/`"3"`/...）。 */
  hitAtK: Record<string, number>;
  mrr: number;
  distractorBeatsGoldCount: number;
  goldScoreMin: number | null;
  goldScoreMax: number | null;
  abstainCount: number;
  protectedAtTopCount: number;
  shallowMisfireCount: number;
  abstainedCount: number;
  abstainTopScoreMin: number | null;
  abstainTopScoreMax: number | null;
  marginStats: MarginStats;
  intrusionMarginStats: MarginStats;
}

export type CorrectionCandidateProbeRunJson =
  | {
      schemaVersion: 1;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      /** `"eval"`（held-out、既定）か `"dev"`（`-- --dev`、調整に使ってよい側）か。 */
      caseSet: "eval" | "dev";
      llmMode: ProviderMode;
      embeddingMode: ProviderMode;
      embeddingSpace: CorrectionCandidateEmbeddingSpaceJson;
      summary: CorrectionCandidateSummaryJson;
      hits: CorrectionCandidateHitJson[];
      abstains: CorrectionCandidateAbstainJson[];
    }
  | {
      schemaVersion: 1;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      /** `warmupLocalEmbedding` が返した detail（`WEIGHTS_UNAVAILABLE_PREFIX` を含む）。 */
      detail: string;
    };

function summaryJson(
  summary: CorrectionCandidateSummary,
  report: CorrectionCandidateReport,
): CorrectionCandidateSummaryJson {
  const hitAtK: Record<string, number> = {};
  for (const [k, v] of Object.entries(summary.hitAtK)) {
    hitAtK[k] = v;
  }
  return {
    hitCount: summary.hitCount,
    hitAtK,
    mrr: summary.mrr,
    distractorBeatsGoldCount: summary.distractorBeatsGoldCount,
    goldScoreMin: summary.goldScoreMin,
    goldScoreMax: summary.goldScoreMax,
    abstainCount: summary.abstainCount,
    protectedAtTopCount: summary.protectedAtTopCount,
    shallowMisfireCount: summary.shallowMisfireCount,
    abstainedCount: summary.abstainedCount,
    abstainTopScoreMin: summary.abstainTopScoreMin,
    abstainTopScoreMax: summary.abstainTopScoreMax,
    marginStats: report.marginStats,
    intrusionMarginStats: report.intrusionMarginStats,
  };
}

/**
 * 計測できたときの JSON を組み立てる。**出所は `CorrectionCandidateReport` だけ**
 * （`./identifier-json.js`/`./numeral-token-json.js` と同じ規律）。
 */
export function buildMeasuredCorrectionCandidateProbeJson(options: {
  report: CorrectionCandidateReport;
  summary: CorrectionCandidateSummary;
  caseSet: "eval" | "dev";
  embeddingSpace: CorrectionCandidateEmbeddingSpaceJson;
  measuredAt: Date;
  commit: string | null;
}): CorrectionCandidateProbeRunJson {
  const summary = summaryJson(options.summary, options.report);
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    caseSet: options.caseSet,
    llmMode: options.report.llmMode,
    embeddingMode: options.report.embeddingMode,
    embeddingSpace: options.embeddingSpace,
    summary,
    hits: options.report.hits.map((h) => ({
      caseId: h.caseId,
      goldRank: h.goldRank,
      distractorRank: h.distractorRank,
      distractorBeatsGold: h.distractorBeatsGold,
      goldScore: h.goldScore,
      margin: h.margin,
    })),
    abstains: options.report.abstains.map((a) => ({
      caseId: a.caseId,
      kind: a.kind,
      protectedAtTop: a.protectedAtTop,
      abstained: a.abstained,
      topScore: a.topScore,
      protectedFactScore: a.protectedFactScore,
      intrusionMargin: a.intrusionMargin,
    })),
  };
}

/**
 * 重みを取得できなかったときの JSON を組み立てる。**メトリクスの欄を一切持たない**
 * ——`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。
 */
export function buildWeightsUnavailableCorrectionCandidateProbeJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): CorrectionCandidateProbeRunJson {
  return {
    schemaVersion: 1,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}
