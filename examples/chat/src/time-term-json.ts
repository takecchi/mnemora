import type { PairMember, PairOutcome, TimeTermArmReport } from "./time-term-arm.js";
import type { ProviderMode } from "./providers.js";

/**
 * 条件を書かない数字だけのベンチ出力は壊れた前例がある（ADR 0068・0081）ので、実際に使われた `llmMode`/`embeddingMode` をトップレベルに同居させる。
 * MRR / hit@k は持たない: この arm は gold/distractor の順位ではなく時間項が順位を動かすかを測るので、probe ごとの `outcome` を混ぜた単一の指標は作らない。
 * 数値は丸めずに書く（`toFixed(6)` の表示を経由すると 1e-7 桁の差が消える）。
 */

export interface TimeTermPairMemberJson {
  rank: number;
  /** `affinityMeasured: false`（連想枠経由）なら `null`（`total` という欄自体が無く、比較可能ではない）。 */
  total: number | null;
  similarity: number | null;
  decay: number;
  tagMatch: number;
  freshness: number;
  strength: number;
  digest: string;
}

export interface TimeTermProbeJson {
  probeId: string;
  outcome: PairOutcome;
  totalInScope: number;
  omittedKinds: string[];
  similarityGapWithinPair: number | null;
  freshnessGapWithinPair: number | null;
  freshnessRatio: number | null;
  decayRatio: number | null;
  totalRatio: number | null;
  newer: TimeTermPairMemberJson | null;
  older: TimeTermPairMemberJson | null;
}

export interface TimeTermRunJson {
  schemaVersion: 1;
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない。`./git-info.js` 参照）。 */
  commit: string | null;
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `report.probes.length`。件数をどこにも書き写さない（ADR 0068 の再発防止と同じ規律）。 */
  probeCount: number;
  probes: TimeTermProbeJson[];
}

export interface BuildTimeTermJsonOptions {
  report: TimeTermArmReport;
  measuredAt: Date;
  commit: string | null;
}

function memberJson(member: PairMember | null): TimeTermPairMemberJson | null {
  if (member === null) {
    return null;
  }
  const score = member.score;
  return {
    rank: member.rank,
    total: score.affinityMeasured === false ? null : score.total,
    similarity: score.affinityMeasured === false ? null : (score.similarity ?? null),
    decay: member.score.decay,
    tagMatch: member.score.tagMatch,
    freshness: member.score.freshness,
    strength: member.score.strength,
    digest: member.digest,
  };
}

/** 純関数。集計をここで作り直さず、`report.probes` をそのまま写す。 */
export function buildTimeTermJson(options: BuildTimeTermJsonOptions): TimeTermRunJson {
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
      outcome: p.outcome,
      totalInScope: p.totalInScope,
      omittedKinds: [...p.omittedKinds],
      similarityGapWithinPair: p.similarityGapWithinPair,
      freshnessGapWithinPair: p.freshnessGapWithinPair,
      freshnessRatio: p.freshnessRatio,
      decayRatio: p.decayRatio,
      totalRatio: p.totalRatio,
      newer: memberJson(p.newer),
      older: memberJson(p.older),
    })),
  };
}
