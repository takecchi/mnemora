import type { IdentifierArmReport, MarginStats } from "./identifier-arm.js";
import type { NumeralTokenHaystackKind } from "./numeral-token-probe-set.js";
import type { ProviderMode } from "./providers.js";

/**
 * `numeral-token-probes` の機械可読な出力口。`./identifier-json.js` と同じ作法で、`status` の判別 union により
 * 「重みを取得できなかった」と「測ったが値が悪かった」を型で区別する。
 * 持つのは sparse/dense の2群だけ。第3の比較対象（日本語意味 probe）を再測定する動機が無い（`identifier-probes` ジョブが担っている）。
 */

export interface NumeralTokenProbeGroupJson {
  label: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: { provider: string; model: string; dimensions: number };
  haystackKind: NumeralTokenHaystackKind;
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  marginStats: MarginStats;
}

export type NumeralTokenProbeRunJson =
  | {
      schemaVersion: 1;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      sparse: NumeralTokenProbeGroupJson;
      dense: NumeralTokenProbeGroupJson;
    }
  | {
      schemaVersion: 1;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      detail: string;
    };

export interface EmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

const EMPTY_MARGIN_STATS: MarginStats = { count: 0, mean: null, stdDev: null, min: null };

function groupJson(
  report: IdentifierArmReport,
  embeddingSpace: EmbeddingSpaceJson,
): NumeralTokenProbeGroupJson {
  return {
    label: report.armLabel,
    llmMode: report.llmMode,
    embeddingMode: report.embeddingMode,
    embeddingSpace,
    haystackKind: report.haystackKind,
    mrrOverall: report.mrrOverall,
    hit1Count: report.hit1Count,
    hit10Count: report.hit10Count,
    probeCount: report.probeCount,
    // 型のためだけの防御（`marginStats` は `IdentifierArmReport` 上 optional）。「測ったが0件」との違いは `EMPTY_MARGIN_STATS` の `count: 0` が表す。
    marginStats: report.marginStats ?? EMPTY_MARGIN_STATS,
  };
}

export function buildMeasuredNumeralTokenProbeJson(options: {
  sparseReport: IdentifierArmReport;
  denseReport: IdentifierArmReport;
  embeddingSpace: EmbeddingSpaceJson;
  measuredAt: Date;
  commit: string | null;
}): NumeralTokenProbeRunJson {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    sparse: groupJson(options.sparseReport, options.embeddingSpace),
    dense: groupJson(options.denseReport, options.embeddingSpace),
  };
}

/** メトリクスの欄を一切持たない——`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。 */
export function buildWeightsUnavailableNumeralTokenProbeJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): NumeralTokenProbeRunJson {
  return {
    schemaVersion: 1,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}
