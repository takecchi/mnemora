import type { AssociationArmReport } from "./association-arm.js";

/**
 * `association-probes` の機械可読な出力口。summary スクリプトが出力スキーマを前提にしているので、キー名を変えない。
 * `embedding` と `recallLimit` は cli 側が定数から取って渡す。ここでは値を手で書かない。
 */

export interface AssociationEmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

export interface AssociationWarmupJson {
  ok: boolean;
  detail: string | null;
}

export interface AssociationDeltaJson {
  baselineArmLabel: string;
  againstArmLabel: string;
  goldReturnedCount: number;
  goldViaAssociationCount: number;
  mrr: number;
  hit10Count: number;
  memoryCharsTotal: number;
  charsPerAdditionalGold: number | null;
}

export interface AssociationProbeRunJson {
  schemaVersion: 1;
  measuredAt: string;
  commit: string | null;
  embedding: AssociationEmbeddingSpaceJson;
  llmMode: "deterministic";
  probeCount: number;
  haystackSize: number;
  recallLimit: number;
  warmup: AssociationWarmupJson;
  arms: AssociationArmReport[];
  deltas: AssociationDeltaJson[];
}

function buildAssociationDelta(
  baseline: AssociationArmReport,
  against: AssociationArmReport,
): AssociationDeltaJson {
  const goldReturnedCount = against.goldReturnedCount - baseline.goldReturnedCount;
  const memoryCharsTotal = against.memoryCharsTotal - baseline.memoryCharsTotal;
  return {
    baselineArmLabel: baseline.armLabel,
    againstArmLabel: against.armLabel,
    goldReturnedCount,
    goldViaAssociationCount: against.goldViaAssociationCount,
    mrr: against.mrr - baseline.mrr,
    hit10Count: against.hit10Count - baseline.hit10Count,
    memoryCharsTotal,
    charsPerAdditionalGold: goldReturnedCount > 0 ? memoryCharsTotal / goldReturnedCount : null,
  };
}

export interface BuildAssociationProbeRunJsonOptions {
  offReport: AssociationArmReport;
  on3Report: AssociationArmReport;
  on5Report: AssociationArmReport;
  on10Report: AssociationArmReport;
  embeddingSpace: AssociationEmbeddingSpaceJson;
  recallLimit: number;
  warmup: { ok: boolean; detail: string };
  measuredAt: Date;
  commit: string | null;
}

/** 計測できたときの JSON を組み立てる純関数。`probeCount`/`haystackSize` は `offReport` から導く。書き写すと呼び出し側が別の値を渡したときに古い値が残る。 */
export function buildAssociationProbeRunJson(
  options: BuildAssociationProbeRunJsonOptions,
): AssociationProbeRunJson {
  const probeCount = options.offReport.probeCount;
  const haystackSize = options.offReport.ingestedCount - probeCount * 3;

  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    embedding: options.embeddingSpace,
    llmMode: "deterministic",
    probeCount,
    haystackSize,
    recallLimit: options.recallLimit,
    warmup: {
      ok: options.warmup.ok,
      detail: options.warmup.ok ? null : options.warmup.detail,
    },
    arms: [options.offReport, options.on3Report, options.on5Report, options.on10Report],
    deltas: [
      buildAssociationDelta(options.offReport, options.on3Report),
      buildAssociationDelta(options.offReport, options.on5Report),
      buildAssociationDelta(options.offReport, options.on10Report),
    ],
  };
}
