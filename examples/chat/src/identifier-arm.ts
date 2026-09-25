import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
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
 * `./identifier-probe-set.js` の probe を測る arm(Issue #109)。
 *
 * **`./retrieval-quality.js` の `runRetrievalQualityArm` とほぼ同じ形**(gold/distractor
 * を1本の会話に ingest → probe ごとに `recall()` を1回投げて順位を測る)である。
 * probe set が別ファイルであるため、`./time-term-arm.js` が `./time-term-probe-set.js`
 * を別 arm として切り出した前例に倣い、こちらも独立した arm にする。
 *
 * **スコア内訳の記録・表示は使い回す**(`collectScoreDetails`/`computeTermSpreads`/
 * `formatScoreDetail`/`formatTermSpreads`——いずれも `retrieval-quality.ts` が公開する
 * 純関数で、probe の中身に依らない。`time-term-arm.ts` が同じ関数を re-export ではなく
 * 直接 import して使っているのと同じ流儀)。
 *
 * **ここでは MRR(全体)しか持たない**——`retrieval-quality.ts` の `lexicalControl`
 * (擬似 embedding でも引けるはずの対照群)に相当する区分をこの probe set は持たない
 * (`IdentifierProbe` に `lexicalControl` 相当の欄が無い。**全件が「識別子を
 * 含む問い」**であり、対照群を分ける設計にしていない——この母数で対照群まで割ると
 * 1群あたりの件数がさらに小さくなり、何も主張できなくなるため)。
 */

export interface IdentifierProbeOutcome {
  probeId: string;
  /** probe 集合ごとに語彙が違う（識別子集合は person/channel/... 、日本語固有名詞集合は person/org/...）。
   *  ⟹ 特定の union に固定せず `string` で受ける。 */
  category: string;
  /** `recall().memories` の中の gold の順位(1始まり)。居なければ null。 */
  goldRank: number | null;
  distractorRank: number | null;
  hit1: boolean;
  hit10: boolean;
  /** 同じ書式・違う識別子(distractor)が gold より上に来たか(Issue #106 の失敗そのもの)。 */
  distractorBeatsGold: boolean;
  reciprocalRank: number;
  omittedKinds: string[];
  totalInScope: number;
  scoreDetails: ProbeScoreDetail[];
  termSpreads: TermSpread[];
  /**
   * `similarity(gold) − similarity(distractor)`(ADR 0135 §5.5)。
   *
   * **どちらかが `scoreDetails` に無ければ `null`**——gold/distractor が `limit` の外に
   * 落ちて `scoreDetails` に現れなかった場合や、候補の `score.similarity` 自体が
   * 無い場合(ANN 経由でない候補、`ScoreBreakdown.similarity` は optional)。
   * 「差が0だった」と「測れなかった」を同じ顔にしない(ADR 0033 の「無いには種類がある」の
   * この値への適用)。
   *
   * ⭐ **hit@1 と併記する。置き換えない**——hit@1 は「limit の窓に入ったか」という
   * 別の情報を持ち、margin だけでは `omitted`(閾値落ち・窓落ち)を区別できない。
   */
  margin: number | null;
}

/**
 * probe ごとの `margin` の分布を、arm 全体で要約したもの(ADR 0135 §5.5)。
 * ADR 0110 §3 の Welch t 検定の表と同じ形の集約(平均・標準偏差・最小値)。
 */
export interface MarginStats {
  /** margin が測れた(gold/distractor 双方に similarity があった) probe の件数。 */
  count: number;
  /** `count === 0` のときは null(平均を定義できない)。 */
  mean: number | null;
  /** 標本標準偏差(自由度 n−1)。`count < 2` のときは null(分散を定義できない)。 */
  stdDev: number | null;
  /** `count === 0` のときは null。 */
  min: number | null;
}

/**
 * probe ごとの `margin`(`number | null`)から `MarginStats` を作る純関数。
 * `null`(測れなかった)は分母からも除く——0として数えると平均が偽って小さくなる。
 */
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

/**
 * gold/distractor の `scoreDetails` から margin を計算する純関数。
 * `collectScoreDetails` が返す配列(役ごとに高々1件)から "gold"/"distractor" の役を
 * 持つ要素を探し、両方に `score.similarity` があれば差を返す。片方でも無ければ `null`。
 */
export function computeMargin(scoreDetails: readonly ProbeScoreDetail[]): number | null {
  const goldSimilarity = scoreDetails.find((d) => d.roles.includes("gold"))?.score.similarity;
  const distractorSimilarity = scoreDetails.find((d) => d.roles.includes("distractor"))?.score
    .similarity;
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
  /** どちらの haystack 条件で走ったか(マネージャー指示: 「条件が3つ(arm/空間/haystack)
   *  になったので、どれ1つ落とさない」)。`"sparse"` = 識別子を含まない既定 haystack、
   *  `"dense"` = probe と同じ書式ファミリーの識別子が密な haystack。 */
  haystackKind: IdentifierHaystackKind;
  ingest: IdentifierArmIngestSummary;
  probes: IdentifierProbeOutcome[];
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  /**
   * probe ごとの `margin` の分布(ADR 0135 §5.5)。
   *
   * ⚠ **省略可能(optional)にしてある**——`runIdentifierProbeArm` は必ずこの欄を
   * 埋めて返すが、型としては optional にすることで、この変更より前に書かれた
   * `IdentifierArmReport` のオブジェクトリテラル(テストの fixture 等)が
   * この欄を持たなくてもコンパイルが通る(後方互換)。ADR 0135 §8-2 が要求する
   * 「既存2集合の report スキーマに影響するが、追加フィールドは任意にする」の実装。
   */
  marginStats?: MarginStats;
}

/**
 * この arm が回す probe 集合。**既定は識別子 probe 集合**であり、
 * 渡さなければ既存の呼び出しと1演算も変わらない（ADR 0094 の測定値を動かさないため）。
 *
 * ⭐ **arm 側を probe 集合から独立させるためだけの口である。**
 * 閾値・limit・overFetchFactor・haystack の作り方には一切触れていない。
 */
export interface ArmProbeSetSpec {
  /** `id` / `query` / `category` だけを要求する（arm はそれ以外を見ない）。 */
  probes: readonly { id: string; query: string; category: string }[];
  buildConversation: (
    haystackSize: number | undefined,
    haystackKind: IdentifierHaystackKind,
  ) => ProbeUtterance[];
  goldExternalId: (probeId: string) => string;
  distractorExternalId: (probeId: string) => string;
}

/** 既定の probe 集合＝ADR 0094 の識別子 probe。 */
export const IDENTIFIER_PROBE_SET_SPEC: ArmProbeSetSpec = {
  probes: IDENTIFIER_PROBES,
  buildConversation: buildIdentifierProbeSetConversation,
  goldExternalId: identifierGoldExternalId,
  distractorExternalId: identifierDistractorExternalId,
};

export interface RunIdentifierProbeArmOptions {
  armLabel: string;
  /** **必ず、この run で初めて使うテナントを渡すこと。**`./retrieval-quality.js` の
   *  `newRunToken()`/`buildArmTenantId()` と同じ理由(ADR 0068)——固定文字列だと2回目の
   *  実行が externalId の冪等性に当たり、ingest の欄が「今回は測っていない」のに
   *  「1回で足りた」という逆の結論を印字する。この arm はその判定式(`IngestMeasurement`)
   *  までは持たない——**このオプションの docstring で「毎回新しいテナントを渡すこと」を
   *  呼び出し側の責務として明示することで代える**(判定式を複製すると、
   *  `retrieval-quality.ts` 側の定義と食い違ったときにどちらが正しいか分からなくなる)。
   */
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `"sparse"`(既定)か `"dense"` か。`./identifier-probe-set.js` の
   *  `buildIdentifierProbeSetConversation` へそのまま渡す。 */
  haystackKind?: IdentifierHaystackKind;
  /** 既定は haystackKind に応じて `./identifier-probe-set.js` 側が決める
   *  (`DEFAULT_HAYSTACK_SIZE`/`DEFAULT_DENSE_HAYSTACK_SIZE`)。 */
  haystackSize?: number;
  /** 回す probe 集合。**省略時は `IDENTIFIER_PROBE_SET_SPEC`**（＝ADR 0094 の識別子 probe）。 */
  probeSet?: ArmProbeSetSpec;
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

  // Issue #719: `observed.memoryIds`（冪等な再送では空配列）を積算し、
  // `drainEmbedTicks` に渡す——「available_at との ms 競合で claim 0件のまま」
  // 黙って抜けないことを検査させる。
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
    // ⛔ `text` 以外を渡さない(既存 arm と同じ規律)——閾値・limit・overFetchFactor は
    // 一切変えない。
    // association: null — 連想枠が既定 on になった（ADR 0335。オーナーが選択肢(あ)を選んだ、ask_human ac5953d1、2026-09-25）
    // でも、この arm（識別子の gold/distractor 順位）の基準線を動かさない。
    const result = await options.runtime.recall(ctx, { text: probe.query, association: null });
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

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function formatRank(rank: number | null): string {
  return rank === null ? "(無し)" : String(rank);
}

function formatMargin(margin: number | null): string {
  return margin === null ? "(測れず)" : margin.toExponential(6);
}

/**
 * Issue #109 続き（ADR 0291/0321）: `correction-candidate-arm.ts` の
 * margin/intrusionMargin の表示にもそのまま再利用する — 表示の書式を複製しない。
 * `identifier-probes`/`numeral-token-probes` の表示から意味は変えていない
 * （エクスポートを足しただけで、この関数自体の入出力は変更していない）。
 */
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

/** probe ごとの内訳と、arm 全体の MRR/hit@1/hit@10 を出す。 */
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
