import type { IdentifierArmReport, MarginStats } from "./identifier-arm.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import type { ProviderMode } from "./providers.js";

/**
 * OpenAI 実埋め込み（`recorded` provider で再生）の機械可読な出力口。`./identifier-json.ts` とは別の単純な形にする——
 * あちらは `local` 専用の固定 union で、重みを取得できないという失敗モードを持つが、こちらには無い。
 * `groups` を配列にするのは、2つのサブコマンドが異なる部分集合を書き出すため。union にすると片方が使わない欄を
 * optional にする必要が生じ、`identifier-probe-baseline.json` が採っている配列の形とも食い違う。
 */

export interface EmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

/** probe 1件ぶんの `margin`。`probeId`/`margin` だけを持ち、他の欄はこの JSON の役割に要らないので複製しない。 */
export interface OpenAiArmProbeMarginJson {
  probeId: string;
  margin: number | null;
}

export interface OpenAiArmGroupJson {
  group: string;
  label: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: EmbeddingSpaceJson;
  haystackKind: IdentifierHaystackKind;
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  marginStats?: MarginStats;
  /**
   * probe ごとの margin。probe の並び順ではなく `probeId` で突き合わせること（呼び出し側の順序が baseline と一致する保証はない）。
   * 省略可能にしてあるのは後方互換のため（既存の baseline JSON はこの欄を持たなかった）。
   */
  probeMargins?: OpenAiArmProbeMarginJson[];
}

export interface OpenAiArmRunJson {
  schemaVersion: 1;
  status: "measured";
  measuredAt: string;
  commit: string | null;
  groups: OpenAiArmGroupJson[];
}

/** `key` は基準値ファイルの `group` と突き合わせる名前（`OpenAiArmGroupKey`）。 */
export function buildOpenAiArmRunJson(
  groups: readonly {
    key: string;
    report: IdentifierArmReport;
    embeddingSpace: EmbeddingSpaceJson;
  }[],
  measuredAt: Date,
  commit: string | null,
): OpenAiArmRunJson {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: measuredAt.toISOString(),
    commit,
    groups: groups.map(({ key, report, embeddingSpace }) => ({
      group: key,
      label: report.armLabel,
      llmMode: report.llmMode,
      embeddingMode: report.embeddingMode,
      embeddingSpace,
      haystackKind: report.haystackKind,
      mrrOverall: report.mrrOverall,
      hit1Count: report.hit1Count,
      hit10Count: report.hit10Count,
      probeCount: report.probeCount,
      ...(report.marginStats !== undefined ? { marginStats: report.marginStats } : {}),
      probeMargins: report.probes.map((p) => ({ probeId: p.probeId, margin: p.margin })),
    })),
  };
}
