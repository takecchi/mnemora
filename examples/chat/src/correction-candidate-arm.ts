import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
import {
  correctionDistractorExternalId,
  correctionGoldExternalId,
  correctionProtectedExternalId,
} from "./correction-case.js";
import type { CorrectionAbstainCase, CorrectionHitCase } from "./correction-case.js";
import { drainEmbedTicks } from "./embed-drain.js";
import type { DrainResult } from "./embed-drain.js";
import { computeMarginStats, formatMarginStats } from "./identifier-arm.js";
import type { MarginStats } from "./identifier-arm.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";
import { requireMeasuredTotal, scoreTotalOrNull } from "./recalled-score.js";

/**
 * 訂正の口の相手探しの精度を測る arm。`identifier-arm.ts` とほぼ同じ形で、違うのは測る量だけ。
 *
 * `recall()` には `text` 以外を渡さない。閾値・`limit`・`overFetchFactor` を変えず、既定の景色を測る。
 * 訂正の発話そのものは `observe()` しない。自分自身が自明に1位を取るのを避けるため。
 * 「訂正を observe してから自己を除外して探す」形（`Runtime.findCorrectionCandidates` の `excludeMemoryIds`）は、この器では測っていない。
 *
 * `intrusionMargin`（ADR 0291 §5.5・ADR 0321）はこの意味のまま凍結する。書き換えず、別名 `protectionMargin`
 * （ADR 0333）を追加して並べて出す。今日のケース集合は `protectedFacts` が0〜1件なので、深い誤爆のとき
 * `intrusionMargin` は常に0になる。これは欠陥ではなく定義どおり。
 *
 * `protectionMargin` の `protectedFactScore` は保護対象のうち最小（最も危うい）を使う。
 * `protectedAtTop` は最大スコアの保護対象が1位かと同値なので、保護対象が2件以上のケースでは符号がねじれうる
 * （ADR 0333 §3.5、未検証。今日のケース集合では表面化しない）。max 版は未実装。
 *
 * 二値（hit@k・誤爆の深/浅）と margin の分布は併記する。置き換えない（ADR 0135/0291 と同じ理由）。
 */

export interface CorrectionHitOutcome {
  caseId: string;
  goldRank: number | null;
  distractorRank: number | null;
  /** 同じ話題・違う主語/値が gold より上に来たか。深刻さの指標。 */
  distractorBeatsGold: boolean;
  /** gold の `ScoreBreakdown.total`。返らなかったなら null（0 へ倒さない）。 */
  goldScore: number | null;
  /**
   * `goldScore − distractorScore`。どちらかが `null` なら `null`。
   * 「差が0だった」と「測れなかった」を同じ顔にしない（ADR 0033）。
   */
  margin: number | null;
  returned: number;
  totalInScope: number;
  omittedKinds: string[];
}

export interface CorrectionAbstainOutcome {
  caseId: string;
  kind: CorrectionAbstainCase["kind"];
  /** 失効させてはいけない事実が1位に来たか（深い誤爆）。守るべき相手が記憶に無いケースでは常に false。 */
  protectedAtTop: boolean;
  abstained: boolean;
  topScore: number | null;
  topDigest: string | null;
  /**
   * `protectedFacts` のうち、`recall()` が返した候補の中で最も順位が低い（最も危うい）ものの `ScoreBreakdown.total`。
   * 1件も返っていなければ `null`。
   */
  protectedFactScore: number | null;
  /**
   * `topScore − protectedFactScore`。深い誤爆のときだけ定義し、誤爆(浅)・棄権のときは `null`。
   * 凍結（ADR 0291 §5.5・ADR 0321 の回帰テストの対象）。定義・計算は変えない。
   */
  intrusionMargin: number | null;
  /** 保護対象でない候補の中の最有力スコア（`maxNonProtectedScore`）。1件も無ければ `null`。`protectionMargin` の計算に使う。 */
  topNonProtectedScore?: number | null;
  /**
   * `protectedFactScore − topNonProtectedScore`。`protectedFacts` が1件以上返っていれば、深い誤爆・誤爆(浅)の両方で定義される。
   * 符号は正が深い誤爆側、負が誤爆(浅)側。`null` はどちらかのスコアが取れなかったとき。
   * 複数件のケースの限界は冒頭の doc を参照（ADR 0333 §3.5）。
   */
  protectionMargin?: number | null;
  returned: number;
  omittedKinds: string[];
}

export interface CorrectionCandidateReport {
  tenantId: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  haystackSize: number;
  observationCount: number;
  ingestDrain: DrainResult;
  hits: CorrectionHitOutcome[];
  abstains: CorrectionAbstainOutcome[];
  marginStats: MarginStats;
  /** B群の `intrusionMargin` の分布。凍結（ADR 0291 §5.5・ADR 0321）。 */
  intrusionMarginStats: MarginStats;
  /** B群の `protectionMargin` の分布。`intrusionMarginStats` と並べて出す後継。 */
  protectionMarginStats?: MarginStats;
}

export function computeCorrectionMargin(
  goldScore: number | null,
  distractorScore: number | null,
): number | null {
  if (goldScore === null || distractorScore === null) {
    return null;
  }
  return goldScore - distractorScore;
}

/**
 * `protectedIds` に含まれる外部IDを持つ候補のうち、`ScoreBreakdown.total` が最も低いものを返す純関数。
 * `memories`/`externalIds` は同じ添字で対応している前提（呼び出し側が揃える）。
 */
export function minProtectedFactScore(
  memories: readonly { score: { total: number } }[],
  externalIds: readonly (string | null)[],
  protectedIds: readonly string[],
): number | null {
  const scores: number[] = [];
  externalIds.forEach((id, i) => {
    if (id !== null && protectedIds.includes(id)) {
      const memory = memories[i];
      if (memory !== undefined) {
        scores.push(memory.score.total);
      }
    }
  });
  return scores.length === 0 ? null : Math.min(...scores);
}

/**
 * B群の `intrusionMargin`。深い誤爆のときだけ `topScore − protectedFactScore` を返す。
 * `protectedFacts` が1件以下なら常に `0` になるが、定義どおりの挙動。
 */
export function computeIntrusionMargin(
  topScore: number | null,
  protectedAtTop: boolean,
  protectedFactScore: number | null,
): number | null {
  if (!protectedAtTop || topScore === null || protectedFactScore === null) {
    return null;
  }
  return topScore - protectedFactScore;
}

/**
 * `protectedIds` に含まれない外部IDを持つ候補のうち、`ScoreBreakdown.total` が最も高いものを返す純関数。
 * `minProtectedFactScore` と対になる。同じ添字対応の契約。
 */
export function maxNonProtectedScore(
  memories: readonly { score: { total: number } }[],
  externalIds: readonly (string | null)[],
  protectedIds: readonly string[],
): number | null {
  const scores: number[] = [];
  externalIds.forEach((id, i) => {
    if (id === null || !protectedIds.includes(id)) {
      const memory = memories[i];
      if (memory !== undefined) {
        scores.push(memory.score.total);
      }
    }
  });
  return scores.length === 0 ? null : Math.max(...scores);
}

/**
 * B群の `protectionMargin`。`protectedFactScore − topNonProtectedScore`。どちらかが `null` なら `null`
 * （「差が0だった」と「測れなかった」を同じ顔にしない）。`protectedAtTop` を問わない。
 * 保護対象が複数件のときに符号が `protectedAtTop` とねじれうる点は冒頭の doc を参照（ADR 0333 §3.5）。
 */
export function computeProtectionMargin(
  protectedFactScore: number | null,
  topNonProtectedScore: number | null,
): number | null {
  if (protectedFactScore === null || topNonProtectedScore === null) {
    return null;
  }
  return protectedFactScore - topNonProtectedScore;
}

export interface RunCorrectionCandidateArmOptions {
  /** 必ず、この run で初めて使うテナントを渡すこと（`identifier-arm.ts` と同じ理由）。 */
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  hitCases: readonly CorrectionHitCase[];
  abstainCases: readonly CorrectionAbstainCase[];
  haystackSize?: number;
}

export async function runCorrectionCandidateArm(
  options: RunCorrectionCandidateArmOptions,
): Promise<CorrectionCandidateReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const haystackSize = options.haystackSize ?? DEFAULT_HAYSTACK_SIZE;

  const utterances: { externalId: string; text: string }[] = [];
  for (const c of options.hitCases) {
    utterances.push({ externalId: correctionGoldExternalId(c.id), text: c.gold });
    utterances.push({ externalId: correctionDistractorExternalId(c.id), text: c.distractor });
  }
  for (const c of options.abstainCases) {
    c.protectedFacts.forEach((fact, i) => {
      utterances.push({ externalId: correctionProtectedExternalId(c.id, i), text: fact });
    });
  }
  for (let i = 0; i < haystackSize; i += 1) {
    utterances.push({
      externalId: `corr-haystack-${String(i)}`,
      text: buildHaystackUtterance(i),
    });
  }

  // `observed.memoryIds` を積算して `drainEmbedTicks` に渡し、claim 0件のまま黙って抜けないことを検査させる。
  let expectedEmbedJobs = 0;
  for (const u of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: u.text,
      externalId: u.externalId,
    });
    expectedEmbedJobs += observed.memoryIds.length;
  }
  const ingestDrain = await drainEmbedTicks(options.runtime, ctx, {
    expectedProcessed: expectedEmbedJobs,
  });

  const hits: CorrectionHitOutcome[] = [];
  for (const c of options.hitCases) {
    // `text` 以外を渡さない。
    // association: null。連想枠が既定 on でも、この arm の基準線を動かさない（ADR 0337）。
    const result = await options.runtime.recall(ctx, { text: c.correction, association: null });
    const externalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndex = externalIds.indexOf(correctionGoldExternalId(c.id));
    const distractorIndex = externalIds.indexOf(correctionDistractorExternalId(c.id));
    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;
    const goldScore =
      goldIndex === -1 ? null : (scoreTotalOrNull(result.memories[goldIndex]!.score) ?? null);
    const distractorScore =
      distractorIndex === -1
        ? null
        : (scoreTotalOrNull(result.memories[distractorIndex]!.score) ?? null);
    hits.push({
      caseId: c.id,
      goldRank,
      distractorRank,
      distractorBeatsGold:
        distractorRank !== null && (goldRank === null || distractorRank < goldRank),
      goldScore,
      margin: computeCorrectionMargin(goldScore, distractorScore),
      returned: result.memories.length,
      totalInScope: result.index.totalInScope,
      omittedKinds: result.omitted.map((o) => o.kind),
    });
  }

  const abstains: CorrectionAbstainOutcome[] = [];
  for (const c of options.abstainCases) {
    const result = await options.runtime.recall(ctx, { text: c.utterance, association: null });
    const topMemory = result.memories[0];
    // 全候補の externalId を解決する（top1 だけではない）。`protectedFacts` が複数件のとき、1位以外の保護対象のスコアも使うため。
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const topExternalId = resolvedExternalIds[0] ?? null;
    const protectedIds = c.protectedFacts.map((_, i) => correctionProtectedExternalId(c.id, i));
    const protectedAtTop = topExternalId !== null && protectedIds.includes(topExternalId);
    // minProtectedFactScore/maxNonProtectedScore は `{ score: { total: number } }[]` という純関数の形をそのまま保つ（歯を書き換えない）。
    const scoredMemories = result.memories.map((m) => ({
      score: { total: requireMeasuredTotal(m.score) },
    }));
    const protectedFactScore = minProtectedFactScore(
      scoredMemories,
      resolvedExternalIds,
      protectedIds,
    );
    const topNonProtectedScore = maxNonProtectedScore(
      scoredMemories,
      resolvedExternalIds,
      protectedIds,
    );
    const topScore = topMemory === undefined ? null : requireMeasuredTotal(topMemory.score);
    abstains.push({
      caseId: c.id,
      kind: c.kind,
      protectedAtTop,
      abstained: topMemory === undefined,
      topScore,
      topDigest: topMemory?.digest ?? null,
      protectedFactScore,
      intrusionMargin: computeIntrusionMargin(topScore, protectedAtTop, protectedFactScore),
      topNonProtectedScore,
      protectionMargin: computeProtectionMargin(protectedFactScore, topNonProtectedScore),
      returned: result.memories.length,
      omittedKinds: result.omitted.map((o) => o.kind),
    });
  }

  return {
    tenantId: options.tenantId,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    haystackSize,
    observationCount: utterances.length,
    ingestDrain,
    hits,
    abstains,
    marginStats: computeMarginStats(hits.map((h) => h.margin)),
    intrusionMarginStats: computeMarginStats(abstains.map((a) => a.intrusionMargin)),
    protectionMarginStats: computeMarginStats(abstains.map((a) => a.protectionMargin ?? null)),
  };
}

export interface CorrectionCandidateSummary {
  hitCount: number;
  hitAtK: Record<number, number>;
  mrr: number;
  distractorBeatsGoldCount: number;
  goldScoreMin: number | null;
  goldScoreMax: number | null;
  abstainCount: number;
  /** 失効させてはいけない事実を1位に置いた件数（深い誤爆）。 */
  protectedAtTopCount: number;
  /** 1位は返ったが、守るべき事実ではなかった件数（浅い誤爆）。 */
  shallowMisfireCount: number;
  abstainedCount: number;
  abstainTopScoreMin: number | null;
  abstainTopScoreMax: number | null;
}

export const CORRECTION_HIT_AT_K = [1, 3, 5, 10] as const;

export function summarizeCorrectionCandidateReport(
  report: CorrectionCandidateReport,
): CorrectionCandidateSummary {
  const hitAtK: Record<number, number> = {};
  for (const k of CORRECTION_HIT_AT_K) {
    hitAtK[k] = report.hits.filter((h) => h.goldRank !== null && h.goldRank <= k).length;
  }
  const goldScores = report.hits.map((h) => h.goldScore).filter((s): s is number => s !== null);
  const abstainScores = report.abstains
    .map((a) => a.topScore)
    .filter((s): s is number => s !== null);
  return {
    hitCount: report.hits.length,
    hitAtK,
    mrr:
      report.hits.length === 0
        ? 0
        : report.hits.reduce((sum, h) => sum + (h.goldRank === null ? 0 : 1 / h.goldRank), 0) /
          report.hits.length,
    distractorBeatsGoldCount: report.hits.filter((h) => h.distractorBeatsGold).length,
    goldScoreMin: goldScores.length === 0 ? null : Math.min(...goldScores),
    goldScoreMax: goldScores.length === 0 ? null : Math.max(...goldScores),
    abstainCount: report.abstains.length,
    protectedAtTopCount: report.abstains.filter((a) => a.protectedAtTop).length,
    shallowMisfireCount: report.abstains.filter((a) => !a.abstained && !a.protectedAtTop).length,
    abstainedCount: report.abstains.filter((a) => a.abstained).length,
    abstainTopScoreMin: abstainScores.length === 0 ? null : Math.min(...abstainScores),
    abstainTopScoreMax: abstainScores.length === 0 ? null : Math.max(...abstainScores),
  };
}

export function formatCorrectionCandidateReport(
  report: CorrectionCandidateReport,
  summary: CorrectionCandidateSummary,
): string {
  const lines: string[] = [];
  const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);
  lines.push(
    `provider: llm=${report.llmMode} / embedding=${report.embeddingMode} / ` +
      `haystack=${String(report.haystackSize)} / observe=${String(report.observationCount)}`,
  );
  lines.push("");
  lines.push(`A 群（訂正すべき相手が実在する。n=${String(summary.hitCount)}）`);
  for (const k of CORRECTION_HIT_AT_K) {
    const c = summary.hitAtK[k] ?? 0;
    lines.push(
      `  hit@${String(k)} = ${String(c)}/${String(summary.hitCount)} (${pct(c, summary.hitCount)})`,
    );
  }
  lines.push(`  MRR = ${summary.mrr.toFixed(4)}`);
  lines.push(
    `  distractor 逆転 = ${String(summary.distractorBeatsGoldCount)}/${String(summary.hitCount)} ` +
      `(${pct(summary.distractorBeatsGoldCount, summary.hitCount)})`,
  );
  lines.push(
    `  gold スコア範囲 = ${summary.goldScoreMin?.toFixed(5) ?? "—"} 〜 ${summary.goldScoreMax?.toFixed(5) ?? "—"}`,
  );
  lines.push(`  margin(goldScore−distractorScore): ${formatMarginStats(report.marginStats)}`);
  lines.push("");
  lines.push(`B 群（⛔ 訂正してはいけない。n=${String(summary.abstainCount)}）`);
  lines.push(
    `  棄権（0件を返した） = ${String(summary.abstainedCount)}/${String(summary.abstainCount)} ` +
      `(${pct(summary.abstainedCount, summary.abstainCount)})`,
  );
  lines.push(
    `  🔴 誤爆・深（1位が失効させてはいけない事実） = ${String(summary.protectedAtTopCount)}/${String(summary.abstainCount)} ` +
      `(${pct(summary.protectedAtTopCount, summary.abstainCount)})`,
  );
  lines.push(
    `  誤爆・浅（1位は返るが守るべき事実ではない） = ${String(summary.shallowMisfireCount)}/${String(summary.abstainCount)} ` +
      `(${pct(summary.shallowMisfireCount, summary.abstainCount)})`,
  );
  lines.push(
    `  1位スコア範囲 = ${summary.abstainTopScoreMin?.toFixed(5) ?? "—"} 〜 ${summary.abstainTopScoreMax?.toFixed(5) ?? "—"}`,
  );
  lines.push(
    `  intrusionMargin(topScore−protectedFactScore、深い誤爆のみ、🧊凍結): ` +
      formatMarginStats(report.intrusionMarginStats),
  );
  if (report.protectionMarginStats !== undefined) {
    lines.push(
      `  protectionMargin(protectedFactScore−topNonProtectedScore、深い誤爆+誤爆(浅)、ADR 0333): ` +
        formatMarginStats(report.protectionMarginStats),
    );
  }
  lines.push("");
  lines.push(
    "⚠ この数字は、この母集合・この provider・この規模についてのものである。代表性は主張しない。",
  );
  return lines.join("\n");
}
