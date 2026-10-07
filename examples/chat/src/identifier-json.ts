import type { IdentifierArmReport } from "./identifier-arm.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import type { ProviderMode } from "./providers.js";
import { armHeadline } from "./retrieval-quality.js";
import type { ArmReport } from "./retrieval-quality.js";

/**
 * `identifier-probes` の機械可読な出力口。数字だけで条件を書かない出力は壊れるので、arm ごとに
 * `llmMode`/`embeddingMode`/`embeddingSpace` を同居させる（次元数だけでは区別できないため `provider`/`model` を添える）。
 *
 * ASCII 識別子 probe は `identifiersSparse`/`identifiersDense` を両方出す。片方に差し替えない
 * （sparse では識別子が埋もれる条件を表せない、という発見を消さない）。
 * 重みを取得できなかったときは各群の欄を存在させない（0 や null で埋めると「測ったら0件」と区別が付かない）。
 */

export interface IdentifierProbeGroupJson {
  label: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: { provider: string; model: string; dimensions: number };
  haystackKind: IdentifierHaystackKind;
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
}

export type IdentifierProbeRunJson =
  | {
      schemaVersion: 2;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      japanese: IdentifierProbeGroupJson;
      identifiersSparse: IdentifierProbeGroupJson;
      identifiersDense: IdentifierProbeGroupJson;
      /** 埋め込み(ANN)が日本語の固有名詞を弁別できるかを測るもので、語彙チャンネルの日本語の制限(ADR 0092)は測らない。 */
      japaneseNamesSparse: IdentifierProbeGroupJson;
      japaneseNamesDense: IdentifierProbeGroupJson;
    }
  | {
      schemaVersion: 2;
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

function japaneseGroupJson(
  report: ArmReport,
  embeddingSpace: EmbeddingSpaceJson,
): IdentifierProbeGroupJson {
  const headline = armHeadline(report);
  return {
    label: report.armLabel,
    llmMode: report.llmMode,
    embeddingMode: report.embeddingMode,
    embeddingSpace,
    haystackKind: "sparse",
    mrrOverall: headline.mrrOverall,
    hit1Count: headline.hit1Count,
    hit10Count: headline.hit10Count,
    probeCount: headline.probeCount,
  };
}

function identifierGroupJson(
  report: IdentifierArmReport,
  embeddingSpace: EmbeddingSpaceJson,
): IdentifierProbeGroupJson {
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
  };
}

export function buildMeasuredIdentifierProbeJson(options: {
  japaneseReport: ArmReport;
  identifierSparseReport: IdentifierArmReport;
  identifierDenseReport: IdentifierArmReport;
  japaneseNameSparseReport: IdentifierArmReport;
  japaneseNameDenseReport: IdentifierArmReport;
  embeddingSpace: EmbeddingSpaceJson;
  measuredAt: Date;
  commit: string | null;
}): IdentifierProbeRunJson {
  return {
    schemaVersion: 2,
    status: "measured",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    japanese: japaneseGroupJson(options.japaneseReport, options.embeddingSpace),
    identifiersSparse: identifierGroupJson(options.identifierSparseReport, options.embeddingSpace),
    identifiersDense: identifierGroupJson(options.identifierDenseReport, options.embeddingSpace),
    japaneseNamesSparse: identifierGroupJson(
      options.japaneseNameSparseReport,
      options.embeddingSpace,
    ),
    japaneseNamesDense: identifierGroupJson(
      options.japaneseNameDenseReport,
      options.embeddingSpace,
    ),
  };
}

/** メトリクスの欄を一切持たない——`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。 */
export function buildWeightsUnavailableIdentifierProbeJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): IdentifierProbeRunJson {
  return {
    schemaVersion: 2,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}
