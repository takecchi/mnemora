import type { Ctx, MemoryStore, RecallAssociationQuery, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { DrainResult } from "./embed-drain.js";
import {
  IDENTIFIER_PROBES,
  buildIdentifierProbeSetConversation,
  identifierDistractorExternalId,
  identifierGoldExternalId,
} from "./identifier-probe-set.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import type { ProbeUtterance } from "./probe-set.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";
import {
  collectScoreDetails,
  computeTermSpreads,
  formatScoreDetail,
  formatTermSpreads,
} from "./retrieval-quality.js";
import type { ProbeScoreDetail, TermSpread } from "./retrieval-quality.js";

/**
 * `./retrieval-quality.js` の arm とほぼ同じ形。MRR(全体)しか持たないのは、probe に対照群を分ける欄が無く、
 * この母数で割ると1群あたりの件数が小さすぎて何も主張できなくなるため。
 */

export interface IdentifierProbeOutcome {
  probeId: string;
  /** probe 集合ごとに語彙が違うので、特定の union に固定せず `string` で受ける。 */
  category: string;
  goldRank: number | null;
  distractorRank: number | null;
  hit1: boolean;
  hit10: boolean;
  distractorBeatsGold: boolean;
  reciprocalRank: number;
  omittedKinds: string[];
  totalInScope: number;
  scoreDetails: ProbeScoreDetail[];
  termSpreads: TermSpread[];
  /**
   * `similarity(gold) − similarity(distractor)`。どちらかが `scoreDetails` に無ければ `null`
   * （「差が0だった」と「測れなかった」を同じ顔にしない）。hit@1 と併記し、置き換えない
   * （margin だけでは `omitted` の閾値落ちと窓落ちを区別できない）。
   */
  margin: number | null;
  associationRows?: number;
}

export interface MarginStats {
  count: number;
  mean: number | null;
  stdDev: number | null;
  min: number | null;
}

/** `null`(測れなかった)は分母からも除く——0として数えると平均が偽って小さくなる。 */
export function computeMarginStats(margins: readonly (number | null)[]): MarginStats {
  const present = margins.filter((m): m is number => m !== null);
  if (present.length === 0) {
    return { count: 0, mean: null, stdDev: null, min: null };
  }
  const mean = present.reduce((sum, v) => sum + v, 0) / present.length;
  const min = Math.min(...present);
  let stdDev: number | null = null;
  if (present.length >= 2) {
    const variance = present.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (present.length - 1);
    stdDev = Math.sqrt(variance);
  }
  return { count: present.length, mean, stdDev, min };
}

export function computeMargin(scoreDetails: readonly ProbeScoreDetail[]): number | null {
  const goldScore = scoreDetails.find((d) => d.roles.includes("gold"))?.score;
  const distractorScore = scoreDetails.find((d) => d.roles.includes("distractor"))?.score;
  const goldSimilarity = goldScore?.affinityMeasured === false ? undefined : goldScore?.similarity;
  const distractorSimilarity =
    distractorScore?.affinityMeasured === false ? undefined : distractorScore?.similarity;
  if (goldSimilarity === undefined || distractorSimilarity === undefined) {
    return null;
  }
  return goldSimilarity - distractorSimilarity;
}

export interface IdentifierArmIngestSummary {
  observationCount: number;
  drain: DrainResult;
}

export interface IdentifierArmReport {
  armLabel: string;
  tenantId: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  haystackKind: IdentifierHaystackKind;
  ingest: IdentifierArmIngestSummary;
  probes: IdentifierProbeOutcome[];
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  /** 省略可能にしてあるのは、この欄を持たない既存の `IdentifierArmReport` リテラル（fixture 等）のコンパイルを壊さないため。 */
  marginStats?: MarginStats;
}

/**
 * この arm が回す probe 集合。既定は識別子 probe 集合。arm を probe 集合から独立させるためだけの口で、
 * 閾値・limit・overFetchFactor・haystack の作り方には触れない。
 */
export interface ArmProbeSetSpec {
  probes: readonly { id: string; query: string; category: string }[];
  buildConversation: (
    haystackSize: number | undefined,
    haystackKind: IdentifierHaystackKind,
  ) => ProbeUtterance[];
  goldExternalId: (probeId: string) => string;
  distractorExternalId: (probeId: string) => string;
}

export const IDENTIFIER_PROBE_SET_SPEC: ArmProbeSetSpec = {
  probes: IDENTIFIER_PROBES,
  buildConversation: buildIdentifierProbeSetConversation,
  goldExternalId: identifierGoldExternalId,
  distractorExternalId: identifierDistractorExternalId,
};

export interface RunIdentifierProbeArmOptions {
  armLabel: string;
  /**
   * **必ず、この run で初めて使うテナントを渡すこと。** 固定文字列だと2回目の実行が externalId の冪等性に当たり、
   * ingest の欄が「今回は測っていない」のに「1回で足りた」と印字する。この arm は `IngestMeasurement` の判定式を持たない
   * （複製すると `retrieval-quality.ts` の定義と食い違ったときにどちらが正しいか分からなくなる）ので、呼び出し側の責務にする。
   */
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  haystackKind?: IdentifierHaystackKind;
  haystackSize?: number;
  probeSet?: ArmProbeSetSpec;
  /** `recall()` に渡す `association`。省略時は `null`——この arm の基準線を変えない。 */
  association?: RecallAssociationQuery | null;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export async function runIdentifierProbeArm(
  options: RunIdentifierProbeArmOptions,
): Promise<IdentifierArmReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const haystackKind = options.haystackKind ?? "sparse";
  const probeSet = options.probeSet ?? IDENTIFIER_PROBE_SET_SPEC;
  const utterances = probeSet.buildConversation(options.haystackSize, haystackKind);

  // 冪等な再送では `observed.memoryIds` が空になるので積算し、`drainEmbedTicks` に渡す（claim 0件のまま黙って抜けさせない）。
  let expectedEmbedJobs = 0;
  for (const utterance of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    expectedEmbedJobs += observed.memoryIds.length;
  }

  const drain = await drainEmbedTicks(options.runtime, ctx, {
    expectedProcessed: expectedEmbedJobs,
  });

  const probes: IdentifierProbeOutcome[] = [];
  for (const probe of probeSet.probes) {
    // ⛔ `text` 以外を渡さない(既存 arm と同じ規律)——閾値・limit・overFetchFactor は一切変えない。
    const result = await options.runtime.recall(ctx, {
      text: probe.query,
      association: options.association ?? null,
    });
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndex = resolvedExternalIds.indexOf(probeSet.goldExternalId(probe.id));
    const distractorIndex = resolvedExternalIds.indexOf(probeSet.distractorExternalId(probe.id));
    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;
    const distractorBeatsGold =
      distractorRank !== null && (goldRank === null || distractorRank < goldRank);
    const scoreDetails = collectScoreDetails(result.memories, { goldRank, distractorRank });

    probes.push({
      probeId: probe.id,
      category: probe.category,
      goldRank,
      distractorRank,
      hit1: goldRank === 1,
      hit10: goldRank !== null,
      distractorBeatsGold,
      reciprocalRank: goldRank !== null ? 1 / goldRank : 0,
      omittedKinds: result.omitted.map((o) => o.kind),
      totalInScope: result.index.totalInScope,
      scoreDetails,
      termSpreads: computeTermSpreads(result.memories),
      margin: computeMargin(scoreDetails),
      associationRows: result.memories.filter((m) => m.retrievedVia === "association").length,
    });
  }

  return {
    armLabel: options.armLabel,
    tenantId: options.tenantId,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    haystackKind,
    marginStats: computeMarginStats(probes.map((p) => p.margin)),
    ingest: {
      observationCount: utterances.length,
      drain,
    },
    probes,
    mrrOverall: average(probes.map((p) => p.reciprocalRank)),
    hit1Count: probes.filter((p) => p.hit1).length,
    hit10Count: probes.filter((p) => p.hit10).length,
    probeCount: probes.length,
  };
}

function formatRank(rank: number | null): string {
  return rank === null ? "(無し)" : String(rank);
}

function formatMargin(margin: number | null): string {
  return margin === null ? "(測れず)" : margin.toExponential(6);
}

export function formatMarginStats(stats: MarginStats): string {
  if (stats.count === 0) {
    return "(測れた probe が0件)";
  }
  const stdDevText = stats.stdDev === null ? "(n<2)" : stats.stdDev.toExponential(6);
  return (
    `n=${stats.count} mean=${stats.mean!.toExponential(6)} ` +
    `stdDev=${stdDevText} min=${stats.min!.toExponential(6)}`
  );
}

export function formatIdentifierArmReport(report: IdentifierArmReport): string {
  const lines: string[] = [];
  lines.push(`=== identifier-probe arm ${report.armLabel}(tenant=${report.tenantId}) ===`);
  lines.push(
    `provider: llm=${report.llmMode} / embedding=${report.embeddingMode} / ` +
      `haystack=${report.haystackKind}`,
  );
  lines.push(
    `ingest: observations=${report.ingest.observationCount} ` +
      `ticks=${report.ingest.drain.ticks} ` +
      `firstTickProcessed=${report.ingest.drain.firstTickProcessed} ` +
      `totalProcessed=${report.ingest.drain.totalProcessed} ` +
      `totalFailed=${report.ingest.drain.totalFailed}`,
  );
  for (const p of report.probes) {
    lines.push(
      `  - ${p.probeId}[${p.category}]: goldRank=${formatRank(p.goldRank)} hit@1=${p.hit1} ` +
        `hit@10=${p.hit10} distractorRank=${formatRank(p.distractorRank)} ` +
        `distractorBeatsGold=${p.distractorBeatsGold} omitted=[${p.omittedKinds.join(",")}] ` +
        `totalInScope=${p.totalInScope} margin=${formatMargin(p.margin)}`,
    );
    lines.push(`      項ごとの値の幅(返った候補全体): ${formatTermSpreads(p.termSpreads)}`);
    for (const detail of p.scoreDetails) {
      lines.push(`      ${formatScoreDetail(detail)}`);
    }
  }
  lines.push(
    `MRR: ${report.mrrOverall.toFixed(3)} ` +
      `hit@1=${report.hit1Count}/${report.probeCount} ` +
      `hit@10=${report.hit10Count}/${report.probeCount}`,
  );
  if (report.marginStats) {
    lines.push(`margin: ${formatMarginStats(report.marginStats)}`);
  }
  return lines.join("\n");
}
