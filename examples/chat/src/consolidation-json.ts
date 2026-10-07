import { heuristicTokenCounter } from "@mnemora/core";
import type { ProviderMode } from "./providers.js";

/**
 * `consolidation-cost` サブコマンドの機械可読出力口。ファイル I/O・環境変数・時刻取得を行わない純関数だけを置く。
 *
 * 縮み率（前後の比）はここでは書かない。数字を書き写さず、差分は `scripts/consolidation-cost-summary.mjs` が
 * 基準値との比較として計算する。
 */

export interface ConsolidationEmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

/**
 * `ConsolidateOutcome`（`packages/core`）をそのまま数え上げたもの。
 *
 * `ConsolidateOutcome` の全値と1対1で揃えること。`outcomes[result.outcome] += 1` が全値を index できることを
 * 型検査で保証するため、`packages/core` の union に値が増えたらここにも同名の欄を足す。
 * `dryRun` と `aborted_source_forgotten` はこの bench では起きない想定だが、常に0で埋める。
 */
export interface ConsolidationOutcomeCountsJson {
  consolidated: number;
  nothing_to_consolidate: number;
  not_examined: number;
  llm_failed: number;
  dry_run: number;
  aborted_source_forgotten: number;
  aborted_source_status_changed: number;
}

export interface ConsolidationEmbeddingStatusJson {
  ok: number;
  pending: number;
  failed: number;
}

export interface ConsolidationRoundConsolidationJson {
  groups: number;
  llmCalls: number;
  outcomes: ConsolidationOutcomeCountsJson;
  newMemoryCount: number;
  embeddingStatus: ConsolidationEmbeddingStatusJson;
  /** `embeddingStatus: "failed"` に着地した Memory の失敗理由を重複を潰して列挙したもの。判別できなければ `"unknown"`。 */
  embeddingFailureKinds: string[];
}

export interface ConsolidationStoreJson {
  activeCount: number;
  supersededCount: number;
  activeContentChars: number;
  activeContentTokens: number;
  activeDigestChars: number;
  activeDigestTokens: number;
  /** active + superseded の合計。必ず増える（隠さない）。 */
  allContentChars: number;
}

export interface ConsolidationRecallProbeJson {
  probeId: string;
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  goldRank: number | null;
  recalledActiveShare: number;
  omittedKinds: string[];
  budgetExceeded: boolean;
}

export interface ConsolidationRecallMeanJson {
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  recalledActiveShare: number;
  goldRank: number | null;
  goldRankExcludedCount: number;
}

export interface ConsolidationRecallUnbudgetedJson {
  probes: ConsolidationRecallProbeJson[];
  mean: ConsolidationRecallMeanJson;
}

export interface ConsolidationRecallBudgetRungJson {
  budgetTokens: number;
  probes: ConsolidationRecallProbeJson[];
  mean: ConsolidationRecallMeanJson;
}

export interface ConsolidationRoundJson {
  round: number;
  consolidation: ConsolidationRoundConsolidationJson | null;
  store: ConsolidationStoreJson;
  recall: {
    unbudgeted: ConsolidationRecallUnbudgetedJson;
    budgeted: ConsolidationRecallBudgetRungJson[];
  };
}

export type ConsolidationStopReason =
  | "completed_all_rounds"
  | "insufficient_candidates"
  /** 例外で打ち切った。詳細は `abort` 欄。 */
  | "aborted_on_error";

export interface ConsolidationAbortJson {
  round: number;
  causeChain: string[];
  sqlState: string | null;
}

/**
 * `status` で「測ったが値がこうだった」と「そもそも測れなかった」を区別する。
 * `"weights_unavailable"` のときは round の欄が丸ごと存在しない。0 や空配列で埋めない（ADR 0008）。
 */
export type ConsolidationCostRunJson =
  | {
      schemaVersion: 1;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      llmMode: ProviderMode;
      embeddingMode: ProviderMode;
      embeddingSpace: ConsolidationEmbeddingSpaceJson;
      probeCount: number;
      haystackSize: number;
      groupSize: number;
      budgetLadder: number[];
      recallLimit: number;
      stoppedAfterRound: number;
      stopReason: ConsolidationStopReason;
      rounds: ConsolidationRoundJson[];
      /** `stopReason === "aborted_on_error"` のときだけ非 null。`null` は「打ち切っていない」であって「詳細不明」ではない。 */
      abort: ConsolidationAbortJson | null;
    }
  | {
      schemaVersion: 1;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      detail: string;
    };

/** `carriedCount / activeCount`。`activeCount === 0` のときは 0。分母0の割り算を NaN のまま JSON へ出さない。 */
export function computeRecalledActiveShare(carriedCount: number, activeCount: number): number {
  if (activeCount <= 0) {
    return 0;
  }
  return carriedCount / activeCount;
}

/** 単純平均。空配列は 0。0除算で NaN を出さない。 */
function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function meanExcludingNullGoldRank(values: readonly (number | null)[]): {
  mean: number | null;
  excludedCount: number;
} {
  const present = values.filter((v): v is number => v !== null);
  const excludedCount = values.length - present.length;
  return { mean: present.length === 0 ? null : mean(present), excludedCount };
}

export function carriedDigestTokensOf(digests: readonly string[]): number {
  return heuristicTokenCounter.count(digests.join("\n")).tokens;
}

export interface RawProbeMeasurement {
  probeId: string;
  memoryDigests: readonly string[];
  goldRank: number | null;
  totalInScope: number;
  omittedKinds: readonly string[];
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  budgetExceeded: boolean;
}

export function buildConsolidationProbeJson(
  raw: RawProbeMeasurement,
  activeCount: number,
): ConsolidationRecallProbeJson {
  return {
    probeId: raw.probeId,
    carriedCount: raw.memoryDigests.length,
    carriedDigestTokens: carriedDigestTokensOf(raw.memoryDigests),
    usageChars: raw.usageChars,
    usageEstimatedTokens: raw.usageEstimatedTokens,
    usageIndexChars: raw.usageIndexChars,
    totalInScope: raw.totalInScope,
    goldRank: raw.goldRank,
    recalledActiveShare: computeRecalledActiveShare(raw.memoryDigests.length, activeCount),
    omittedKinds: [...raw.omittedKinds],
    budgetExceeded: raw.budgetExceeded,
  };
}

export function buildConsolidationMeanJson(
  probes: readonly ConsolidationRecallProbeJson[],
): ConsolidationRecallMeanJson {
  const goldRanks = meanExcludingNullGoldRank(probes.map((p) => p.goldRank));
  return {
    carriedCount: mean(probes.map((p) => p.carriedCount)),
    carriedDigestTokens: mean(probes.map((p) => p.carriedDigestTokens)),
    usageChars: mean(probes.map((p) => p.usageChars)),
    usageEstimatedTokens: mean(probes.map((p) => p.usageEstimatedTokens)),
    usageIndexChars: mean(probes.map((p) => p.usageIndexChars)),
    totalInScope: mean(probes.map((p) => p.totalInScope)),
    recalledActiveShare: mean(probes.map((p) => p.recalledActiveShare)),
    goldRank: goldRanks.mean,
    goldRankExcludedCount: goldRanks.excludedCount,
  };
}

export interface RawStoreMeasurement {
  activeContentsAndDigests: readonly { content: string; digest: string }[];
  supersededCount: number;
  allContentChars: number;
}

export function buildConsolidationStoreJson(raw: RawStoreMeasurement): ConsolidationStoreJson {
  const activeContentChars = raw.activeContentsAndDigests.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );
  const activeDigestChars = raw.activeContentsAndDigests.reduce(
    (sum, m) => sum + m.digest.length,
    0,
  );
  return {
    activeCount: raw.activeContentsAndDigests.length,
    supersededCount: raw.supersededCount,
    activeContentChars,
    activeContentTokens: heuristicTokenCounter.count(
      raw.activeContentsAndDigests.map((m) => m.content).join("\n"),
    ).tokens,
    activeDigestChars,
    activeDigestTokens: heuristicTokenCounter.count(
      raw.activeContentsAndDigests.map((m) => m.digest).join("\n"),
    ).tokens,
    allContentChars: raw.allContentChars,
  };
}

export interface BuildConsolidationCostRunJsonOptions {
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: ConsolidationEmbeddingSpaceJson;
  probeCount: number;
  haystackSize: number;
  groupSize: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  stoppedAfterRound: number;
  stopReason: ConsolidationStopReason;
  rounds: ConsolidationRoundJson[];
  measuredAt: Date;
  commit: string | null;
  abort: ConsolidationAbortJson | null;
}

export function buildConsolidationCostRunJson(
  options: BuildConsolidationCostRunJsonOptions,
): Extract<ConsolidationCostRunJson, { status: "measured" }> {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    embeddingSpace: options.embeddingSpace,
    probeCount: options.probeCount,
    haystackSize: options.haystackSize,
    groupSize: options.groupSize,
    budgetLadder: [...options.budgetLadder],
    recallLimit: options.recallLimit,
    stoppedAfterRound: options.stoppedAfterRound,
    stopReason: options.stopReason,
    rounds: options.rounds,
    abort: options.abort,
  };
}

/**
 * 重みを取得できなかったときの JSON を組み立てる。メトリクスの欄を一切持たない。
 * `0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。
 */
export function buildWeightsUnavailableConsolidationCostRunJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): ConsolidationCostRunJson {
  return {
    schemaVersion: 1,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}

export function emptyOutcomeCounts(): ConsolidationOutcomeCountsJson {
  return {
    consolidated: 0,
    nothing_to_consolidate: 0,
    not_examined: 0,
    llm_failed: 0,
    dry_run: 0,
    aborted_source_forgotten: 0,
    aborted_source_status_changed: 0,
  };
}

/**
 * `runtime.consolidate()` が投げた例外を、cause の連鎖を辿った形で記述する。
 *
 * `String(error)` に畳まない。drizzle が pg のエラーを包むので、投げられた例外の message だけでは
 * 元のメッセージも SQLSTATE も失われる。全段の message を集め、SQLSTATE（文字列の `.code`）をどこかの段から探す。
 * `Error` でない値が投げられても落ちず、`causeChain` は最低1件持つ。
 */
export function describeThrownError(error: unknown, round: number): ConsolidationAbortJson {
  const causeChain: string[] = [];
  let sqlState: string | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || current === undefined) {
      if (causeChain.length === 0) {
        causeChain.push(String(current));
      }
      break;
    }
    causeChain.push(current instanceof Error ? current.message : String(current));
    const code = (current as { code?: unknown }).code;
    if (sqlState === null && typeof code === "string") {
      sqlState = code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return { round, causeChain, sqlState };
}

/**
 * `cli.ts` の `runConsolidationCostCommand` が立てる終了コード。
 * `process.exitCode` への副作用は歯で直接検査しづらいため、純関数として切り出した。
 *
 * `weights_unavailable` と `aborted_on_error` は 1、意図した完走・停止は 0。
 */
export function exitCodeForConsolidationCostRun(json: ConsolidationCostRunJson): 0 | 1 {
  if (json.status === "weights_unavailable") {
    return 1;
  }
  if (json.stopReason === "aborted_on_error") {
    return 1;
  }
  return 0;
}
