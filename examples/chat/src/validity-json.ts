import type { ValidityArmReport, ValidityProbeOutcome } from "./validity-arm.js";
import type { ProviderMode } from "./providers.js";

/** 条件を書かない数字だけのベンチ出力は壊れた前例がある（ADR 0068・0081）ので、実際に使われた `llmMode`/`embeddingMode` を同居させる。 */

export interface ValidityProbeJson {
  probeId: string;
  otherReason: ValidityProbeOutcome["otherReason"];
  currentReturnedAtNow: boolean;
  otherReturnedAtNow: boolean;
  omittedConditionsAtNow: string[];
  historical: {
    validAt: string;
    currentReturned: boolean;
    otherReturned: boolean;
    omittedConditions: string[];
  } | null;
  optOutCurrentReturned: boolean;
  optOutOtherReturned: boolean;
  totalInScope: number;
}

export interface ValidityRunJson {
  schemaVersion: 1;
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない）。 */
  commit: string | null;
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  probeCount: number;
  probes: ValidityProbeJson[];
}

export interface BuildValidityJsonOptions {
  report: ValidityArmReport;
  measuredAt: Date;
  commit: string | null;
}

export function buildValidityJson(options: BuildValidityJsonOptions): ValidityRunJson {
  const { report } = options;
  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    armLabel: report.armLabel,
    llmMode: report.llmMode,
    embeddingMode: report.embeddingMode,
    probeCount: report.probes.length,
    probes: report.probes.map((p) => ({
      probeId: p.probeId,
      otherReason: p.otherReason,
      currentReturnedAtNow: p.current.returnedAtNow,
      otherReturnedAtNow: p.other.returnedAtNow,
      omittedConditionsAtNow: [...p.omittedConditionsAtNow],
      historical: p.historical
        ? {
            validAt: p.historical.validAt.toISOString(),
            currentReturned: p.historical.currentReturned,
            otherReturned: p.historical.otherReturned,
            omittedConditions: [...p.historical.omittedConditions],
          }
        : null,
      optOutCurrentReturned: p.optOut.currentReturned,
      optOutOtherReturned: p.optOut.otherReturned,
      totalInScope: p.totalInScope,
    })),
  };
}
