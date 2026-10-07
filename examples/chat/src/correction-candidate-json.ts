import type {
  CorrectionCandidateReport,
  CorrectionCandidateSummary,
} from "./correction-candidate-arm.js";
import type { MarginStats } from "./identifier-arm.js";
import type { ProviderMode } from "./providers.js";

/**
 * `correction-candidates` の機械可読な出力口。
 *
 * `./identifier-json.js`/`./numeral-token-json.js` とは別ファイル。既存の出力口・基準値には触れない。
 * 「重みを取得できなかった」と「測ったが値が悪かった」を `status` の判別 union で型として区別する。
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
  /** 凍結（ADR 0291 §5.5・ADR 0321）。並べて出す後継は `protectionMargin`。 */
  intrusionMargin: number | null;
  /**
   * `protectedFactScore − topNonProtectedScore`。`intrusionMargin` は凍結し、別名で新設した（ADR 0333 §3.2 案2）。
   * 既存フィールドの意味は変えない。
   */
  protectionMargin: number | null;
}

export interface CorrectionCandidateSummaryJson {
  hitCount: number;
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
  /** 凍結（ADR 0291 §5.5・ADR 0321）。 */
  intrusionMarginStats: MarginStats;
  /**
   * `intrusionMarginStats` と並べて出す後継。`report.protectionMarginStats` が無いときはこのフィールド自体を省く。
   * 「測ったが0件だった」と型で区別するため。
   */
  protectionMarginStats?: MarginStats;
}

export type CorrectionCandidateProbeRunJson =
  | {
      schemaVersion: 1;
      status: "measured";
      measuredAt: string;
      commit: string | null;
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
    ...(report.protectionMarginStats !== undefined
      ? { protectionMarginStats: report.protectionMarginStats }
      : {}),
  };
}

/** 計測できたときの JSON を組み立てる。出所は `CorrectionCandidateReport` だけ。 */
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
      protectionMargin: a.protectionMargin ?? null,
    })),
  };
}

/**
 * 重みを取得できなかったときの JSON を組み立てる。メトリクスの欄を一切持たない。
 * `0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。
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
