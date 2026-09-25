import type { IdentifierArmReport, MarginStats } from "./identifier-arm.js";
import type { NumeralTokenHaystackKind } from "./numeral-token-probe-set.js";
import type { ProviderMode } from "./providers.js";

/**
 * `numeral-token-probes` の機械可読な出力口(`./identifier-json.js` と同じ作法。ADR 0135、
 * Issue #109)。
 *
 * ⛔ **`./identifier-json.js`/`examples/chat/identifier-probe-baseline.json` とは
 * 別ファイル**(既存の識別子・日本語固有名詞 probe の出力口・基準値には一切触れていない)。
 *
 * 🔴 **「重みを取得できなかった」と「測ったが値が悪かった」を型で区別する**
 * (`status` の判別union、`./identifier-json.js` と同じ理由)。
 *
 * **2群(sparse/dense)を別々に持つ**(`identifiersSparse`/`identifiersDense` と同じ形)。
 * この集合には「既存の日本語意味probe」に相当する第3の比較対象が無い——ADR 0135 は
 * 単独の弁別軸(数詞・記号索引)のみを対象にしており、`./probe-set.js` の7件をこの arm の
 * embedding で再測定する動機が無い(それは `identifier-probes` ジョブがすでに担っている)。
 *
 * **`marginStats` を各群に持つ**(ADR 0135 §5.5 の核心——hit@1/hit@10 の二値だけでなく、
 * margin の分布(平均・標準偏差・最小値)を機械可読な形で残す)。
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
      /** 数詞・記号索引 probe 18件、識別子を含まない既定 haystack。 */
      sparse: NumeralTokenProbeGroupJson;
      /** 同じ18 probe を、同じ9セルの索引が密な haystack で走らせた結果。 */
      dense: NumeralTokenProbeGroupJson;
    }
  | {
      schemaVersion: 1;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      /** `warmupLocalEmbedding` が返した detail(`WEIGHTS_UNAVAILABLE_PREFIX` を含む)。 */
      detail: string;
    };

export interface EmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

const EMPTY_MARGIN_STATS: MarginStats = { count: 0, mean: null, stdDev: null, min: null };

/** `IdentifierArmReport`(`identifier-arm.ts`)を `NumeralTokenProbeGroupJson` へ写す。 */
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
    // ⚠ `marginStats` は `IdentifierArmReport` 上は optional(既存2集合の後方互換のため)。
    // `runIdentifierProbeArm` は必ず埋めて返すので、実運用でこのフォールバックに落ちることは
    // 無い——型のためだけの防御であり、「測ったが0件だった」との違いは `EMPTY_MARGIN_STATS`
    // 自身の `count: 0` が表す。
    marginStats: report.marginStats ?? EMPTY_MARGIN_STATS,
  };
}

/**
 * 計測できたときの JSON を組み立てる。**出所は `IdentifierArmReport` だけ**
 * (`./identifier-json.js` の `buildMeasuredIdentifierProbeJson` と同じ規律)。
 */
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

/**
 * 重みを取得できなかったときの JSON を組み立てる。**メトリクスの欄を一切持たない**
 * ——`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。
 */
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
