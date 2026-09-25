import type { IdentifierArmReport, MarginStats } from "./identifier-arm.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import type { ProviderMode } from "./providers.js";

/**
 * `identifier-probes`/`numeral-token-probes` サブコマンドが**追加で**書き出す、
 * OpenAI 実埋め込み（`recorded` provider で再生）の機械可読な出力口（Issue #109 後半）。
 *
 * ⛔ **`./identifier-json.ts`（既存の `IdentifierProbeRunJson`）には1文字も触れていない**
 * ——あちらは `local` embedding の5群（`japanese`/`identifiersSparse`/`identifiersDense`/
 * `japaneseNamesSparse`/`japaneseNamesDense`）専用の固定 union であり、`status:
 * "weights_unavailable"` という別の失敗モード（HF から重みを取得できない）を持つ。
 * この6群（識別子×2haystack・日本語固有名詞×2haystack・数詞×2haystack）は
 * `recorded` provider（カセット再生、鍵もネットワークも要らない）なので、
 * その失敗モードが無い——**別の、より単純な形にする**。
 *
 * `groups` を配列にする（`identifier-json.ts` のような固定 union にしない）理由:
 * `identifier-probes`/`numeral-token-probes` の両サブコマンドが、それぞれ異なる
 * 部分集合（4群 / 2群）を書き出す——1つの union 型で両方を表そうとすると、
 * 片方が使わない欄を optional にする必要が生じ、`identifier-probe-baseline.json`
 * (`groups: [...]`) が既に採っている配列の形と食い違う。
 */

export interface EmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

/**
 * probe 1件ぶんの `margin`（ADR 0135 §5.5、`identifier-arm.ts` の
 * `IdentifierProbeOutcome.margin`）。ADR 0333 §2.1 が指摘した欠落
 * （群レベルの集約値=`marginStats` だけで probe ごとの値を保存していなかった）を埋める。
 *
 * ⛔ **`IdentifierProbeOutcome` のうち `probeId`/`margin` だけを持つ**——
 * `scoreDetails`/`termSpreads` 等、他の欄はこの JSON の役割（Job Summary 用の
 * margin基準「並走の判定」候補、ADR 0333 §4.3）に要らないので複製しない。
 */
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
   * probe ごとの margin（ADR 0333 §2.1・§4.3「A」）。`decideMarginDropVerdict`
   * （`verdict-candidate-margin.ts`）が要る唯一の入力——群レベルの `marginStats` だけでは
   * 「どの probe が縮んだか」を突き合わせられない。**probe の並び順ではなく `probeId` で
   * 突き合わせること**（呼び出し側の順序が baseline と一致する保証はない）。
   *
   * ⚠ **省略可能(optional)にしてある**——`marginStats` と同じ理由（後方互換。既存の
   * `identifier-probe-baseline.openai.json`/`numeral-token-probe-baseline.openai.json`
   * はこの欄を追記するまで持っていなかった）。
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

/**
 * `key` は基準値ファイルの `group` と突き合わせる名前
 * （`identifiersSparse`/`identifiersDense`/`japaneseNamesSparse`/`japaneseNamesDense`/
 * `numeralSparse`/`numeralDense`。`../openai-arm-probe-groups.ts` の `OpenAiArmGroupKey`）。
 */
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
