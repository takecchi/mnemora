import { defaultDecayStrategy, heuristicTokenCounter } from "@mnemora/core";
import type { ProviderMode } from "./providers.js";
import { carriedDigestTokensOf, meanExcludingNullGoldRank } from "./consolidation-json.js";

/**
 * `archive-sweep-cost` サブコマンドの機械可読出力口。`consolidation-json.ts` と型を共有しない。sweep は LLM を呼ばず、
 * 新しい Memory を作らず、ラウンドも反復しないので、JSON の形が違う。測定の部品（probe 集合・budget ladder・digest の数え方）は共有する。
 *
 * 縮み率（前後の比）はここでは書かない。差分は `scripts/archive-sweep-cost-summary.mjs` が基準値との比較として計算する。
 */

export interface ArchiveSweepEmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

export interface ArchiveSweepStoreJson {
  activeCount: number;
  supersededCount: number;
  archivedCount: number;
  activeContentChars: number;
  activeContentTokens: number;
  activeDigestChars: number;
  activeDigestTokens: number;
  allContentChars: number;
}

export interface ArchiveSweepProbeJson {
  probeId: string;
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  goldRank: number | null;
  recalledActiveShare: number;
  omittedArchivedCount: number;
  omittedKinds: string[];
  budgetExceeded: boolean;
}

export interface ArchiveSweepMeanJson {
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  recalledActiveShare: number;
  omittedArchivedCount: number;
  goldRank: number | null;
  goldRankExcludedCount: number;
}

export interface ArchiveSweepRecallUnbudgetedJson {
  probes: ArchiveSweepProbeJson[];
  mean: ArchiveSweepMeanJson;
}

export interface ArchiveSweepRecallBudgetRungJson {
  budgetTokens: number;
  probes: ArchiveSweepProbeJson[];
  mean: ArchiveSweepMeanJson;
}

export interface ArchiveSweepRecallJson {
  unbudgeted: ArchiveSweepRecallUnbudgetedJson;
  budgeted: ArchiveSweepRecallBudgetRungJson[];
}

export interface ArchiveSweepPhaseJson {
  store: ArchiveSweepStoreJson;
  recall: ArchiveSweepRecallJson;
}

export interface ArchiveSweepResultJson {
  supported: boolean;
  limit: number;
  archivedCount: number;
  reachedLimit: boolean;
}

export type ArchiveSweepCostRunJson =
  | {
      schemaVersion: 1;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      llmMode: ProviderMode;
      embeddingMode: ProviderMode;
      embeddingSpace: ArchiveSweepEmbeddingSpaceJson;
      probeCount: number;
      haystackSize: number;
      halfLifeHours: number;
      budgetLadder: number[];
      recallLimit: number;
      sweep: ArchiveSweepResultJson;
      before: ArchiveSweepPhaseJson;
      after: ArchiveSweepPhaseJson;
    }
  | {
      schemaVersion: 1;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      detail: string;
    };

const MS_PER_HOUR = 1000 * 60 * 60;

/** `defaultDecayStrategy.floorAt` を呼んで固定オフセット（ミリ秒）を導出する。`packages/core` の減衰式を再導出しない（式を書き写すとずれる）。 */
export function decayFloorOffsetMs(halfLifeHours: number): number {
  const epoch = new Date(0);
  const floor = defaultDecayStrategy.floorAt({
    recordedAt: epoch,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
  });
  return floor.getTime() - epoch.getTime();
}

export function fillerBackdateMs(halfLifeHours: number, marginHours: number): number {
  return decayFloorOffsetMs(halfLifeHours) + marginHours * MS_PER_HOUR;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function computeRecalledActiveShare(carriedCount: number, activeCount: number): number {
  if (activeCount <= 0) {
    return 0;
  }
  return carriedCount / activeCount;
}

export interface RawArchiveSweepProbeMeasurement {
  probeId: string;
  memoryDigests: readonly string[];
  goldRank: number | null;
  totalInScope: number;
  omittedKinds: readonly string[];
  omittedArchivedCount: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  budgetExceeded: boolean;
}

export function buildArchiveSweepProbeJson(
  raw: RawArchiveSweepProbeMeasurement,
  activeCount: number,
): ArchiveSweepProbeJson {
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
    omittedArchivedCount: raw.omittedArchivedCount,
    omittedKinds: [...raw.omittedKinds],
    budgetExceeded: raw.budgetExceeded,
  };
}

export function buildArchiveSweepMeanJson(
  probes: readonly ArchiveSweepProbeJson[],
): ArchiveSweepMeanJson {
  const goldRanks = meanExcludingNullGoldRank(probes.map((p) => p.goldRank));
  return {
    carriedCount: mean(probes.map((p) => p.carriedCount)),
    carriedDigestTokens: mean(probes.map((p) => p.carriedDigestTokens)),
    usageChars: mean(probes.map((p) => p.usageChars)),
    usageEstimatedTokens: mean(probes.map((p) => p.usageEstimatedTokens)),
    usageIndexChars: mean(probes.map((p) => p.usageIndexChars)),
    totalInScope: mean(probes.map((p) => p.totalInScope)),
    recalledActiveShare: mean(probes.map((p) => p.recalledActiveShare)),
    omittedArchivedCount: mean(probes.map((p) => p.omittedArchivedCount)),
    goldRank: goldRanks.mean,
    goldRankExcludedCount: goldRanks.excludedCount,
  };
}

export interface RawArchiveSweepStoreMeasurement {
  activeContentsAndDigests: readonly { content: string; digest: string }[];
  supersededCount: number;
  archivedCount: number;
  allContentChars: number;
}

export function buildArchiveSweepStoreJson(
  raw: RawArchiveSweepStoreMeasurement,
): ArchiveSweepStoreJson {
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
    archivedCount: raw.archivedCount,
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

export interface BuildArchiveSweepCostRunJsonOptions {
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: ArchiveSweepEmbeddingSpaceJson;
  probeCount: number;
  haystackSize: number;
  halfLifeHours: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  sweep: ArchiveSweepResultJson;
  before: ArchiveSweepPhaseJson;
  after: ArchiveSweepPhaseJson;
  measuredAt: Date;
  commit: string | null;
}

export function buildArchiveSweepCostRunJson(
  options: BuildArchiveSweepCostRunJsonOptions,
): Extract<ArchiveSweepCostRunJson, { status: "measured" }> {
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
    halfLifeHours: options.halfLifeHours,
    budgetLadder: [...options.budgetLadder],
    recallLimit: options.recallLimit,
    sweep: options.sweep,
    before: options.before,
    after: options.after,
  };
}

/** 重みを取得できなかったときの JSON。メトリクスの欄を持たない。`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。 */
export function buildWeightsUnavailableArchiveSweepCostRunJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): ArchiveSweepCostRunJson {
  return {
    schemaVersion: 1,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}

/**
 * `cli.ts` の `runArchiveSweepCostCommand` が立てる終了コード。`weights_unavailable` と `sweep.supported === false` は 1。
 * 後者は黙って0件の成功として扱わない。
 */
export function exitCodeForArchiveSweepCostRun(json: ArchiveSweepCostRunJson): 0 | 1 {
  if (json.status === "weights_unavailable") {
    return 1;
  }
  if (!json.sweep.supported) {
    return 1;
  }
  return 0;
}
