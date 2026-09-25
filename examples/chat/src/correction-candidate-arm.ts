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

/**
 * Issue #369 (C)「訂正の口」の相手探しの精度を測る arm。
 *
 * **`identifier-arm.ts` とほぼ同じ形**（ケースを1本の会話に ingest → ケースごとに
 * `recall()` を1回投げて順位を測る）である。違うのは測る量だけ:
 *
 * - **A 群**（訂正すべき相手が実在する）→ hit@k / MRR / **distractor 逆転率**
 * - **B 群**（⛔ 訂正してはいけない）→ **誤爆率（深/浅）** と **棄権率**
 *
 * ⛔ **`recall()` には `text` 以外を渡さない**（既存 arm と同じ規律）——閾値・`limit`・
 * `overFetchFactor` を一切変えない。⟹ **(C) が実際に見ることになる既定の景色を測る。**
 *
 * ⭐ **訂正の発話そのものは `observe()` しない。**自分自身が自明に1位を取るのを避ける
 * ため。⟹ ⚠ **「訂正を observe してから自己を除外して探す」形は、この器では測って
 * いない**（`Runtime.findCorrectionCandidates` の `excludeMemoryIds` がその形を取る）。
 *
 * **`margin`/`intrusionMargin`（[ADR 0291](../../../docs/decisions/0291-primary-probe-coverage-map-correction-candidate-domain.md) §5.5、
 * [ADR 0321](../../../docs/decisions/0321-correction-candidate-domain-implementation.md)）**:
 *
 * - A群: `margin = goldScore − distractorScore`（`ScoreBreakdown.total` の差）。
 *   どちらかが `null`（返らなかった）なら `null`。`identifier-arm.ts` の `margin`
 *   （`similarity` の差）とは**使う値が違う**——この arm はもともと `goldScore` を
 *   `.total` で記録しており、その系譜をそのまま延長した。
 * - B群: `intrusionMargin = topScore − protectedFactScore`。**深い誤爆
 *   （`protectedAtTop === true`）のときだけ**定義し、誤爆(浅)・棄権のときは `null`
 *   （ADR 0291 §5.5 の逐語どおり）。`protectedFactScore` は `protectedFacts`（複数件
 *   ありうる）のうち、返った候補の中で最も順位が低い（＝最も危うい）ものの
 *   `ScoreBreakdown.total`。⚠ **今日のケース集合はどれも `protectedFacts` が0〜1件
 *   なので、深い誤爆のとき `topScore === protectedFactScore` となり
 *   `intrusionMargin` は常に `0`——これは実装の欠陥ではなく定義どおりの挙動である
 *   （ADR 0321 に実測として記録）。**複数件になって初めて非自明な値になる。
 * - `computeMarginStats`（`identifier-arm.ts`、ADR 0135 §5.5）をそのまま再利用し、
 *   arm 全体では平均・標準偏差・最小値の分布で読む。**二値（hit@k・誤爆の深/浅）と
 *   併記する。置き換えない**——ADR 0135/0291 と同じ理由。
 */

/** A 群1件ぶんの結果。 */
export interface CorrectionHitOutcome {
  caseId: string;
  /** `recall().memories` の中の gold の順位（1始まり）。居なければ null。 */
  goldRank: number | null;
  distractorRank: number | null;
  /** 同じ話題・違う主語/値が gold より上に来たか。**これが「深刻さ」の指標である。** */
  distractorBeatsGold: boolean;
  /** gold の `ScoreBreakdown.total`。返らなかったなら null（0 へ倒さない）。 */
  goldScore: number | null;
  /**
   * `goldScore − distractorScore`（ADR 0291 §5.5、ADR 0321）。
   * どちらかが `null`（返らなかった）なら `null`——「差が0だった」と「測れなかった」を
   * 同じ顔にしない（ADR 0033「無いには種類がある」の適用）。
   */
  margin: number | null;
  returned: number;
  totalInScope: number;
  omittedKinds: string[];
}

/** B 群1件ぶんの結果。 */
export interface CorrectionAbstainOutcome {
  caseId: string;
  kind: CorrectionAbstainCase["kind"];
  /**
   * ⛔ 失効させてはいけない事実が1位に来たか（**深い誤爆**）。
   * 「守るべき相手が記憶に無い」ケース（曖昧）では常に false になる。
   */
  protectedAtTop: boolean;
  /** 1位が返らなかった（＝棄権した）か。 */
  abstained: boolean;
  /** 1位の `ScoreBreakdown.total`。棄権したなら null。 */
  topScore: number | null;
  topDigest: string | null;
  /**
   * `protectedFacts`（複数件ありうる）のうち、`recall()` が返した候補の中で
   * 最も順位が低い（＝最も危うい）ものの `ScoreBreakdown.total`。1件も返って
   * いなければ `null`（ADR 0291 §5.5、ADR 0321）。
   */
  protectedFactScore: number | null;
  /**
   * `topScore − protectedFactScore`。**深い誤爆（`protectedAtTop === true`）の
   * ときだけ**定義する。誤爆(浅)・棄権のときは `null`（ADR 0291 §5.5 の逐語）。
   */
  intrusionMargin: number | null;
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
  /** A群の `margin` の分布（ADR 0135 §5.5 と同じ形の集約）。 */
  marginStats: MarginStats;
  /** B群の `intrusionMargin` の分布。 */
  intrusionMarginStats: MarginStats;
}

/**
 * gold/distractor の `ScoreBreakdown.total` から margin を計算する純関数
 * （ADR 0291 §5.5、ADR 0321）。どちらかが `null` なら `null`。
 */
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
 * `protectedIds` に含まれる外部IDを持つ候補のうち、`ScoreBreakdown.total` が
 * 最も低いもの（＝最も危うい）を返す純関数。1件も見つからなければ `null`。
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
 * B群の `intrusionMargin`（ADR 0291 §5.5、ADR 0321）。深い誤爆のときだけ
 * `topScore − protectedFactScore` を返す。誤爆(浅)・棄権のときは `null`。
 *
 * ⚠ `protectedFacts` が1件以下のケースでは、深い誤爆のとき
 * `topScore === protectedFactScore` になり、結果は常に `0`——これは実装の欠陥では
 * なく定義どおりの挙動である（1位そのものが保護対象である以上、自明な結果）。
 * この値が非自明になるのは `protectedFacts` が複数件のケースに限る。
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

export interface RunCorrectionCandidateArmOptions {
  /** ⚠ **必ず、この run で初めて使うテナントを渡すこと**（`identifier-arm.ts` と同じ理由）。 */
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

  // Issue #719: `observed.memoryIds`（冪等な再送では空配列）を積算し、
  // `drainEmbedTicks` に渡す——「available_at との ms 競合で claim 0件のまま」
  // 黙って抜けないことを検査させる。
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
    // ⛔ `text` 以外を渡さない。
    const result = await options.runtime.recall(ctx, { text: c.correction });
    const externalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndex = externalIds.indexOf(correctionGoldExternalId(c.id));
    const distractorIndex = externalIds.indexOf(correctionDistractorExternalId(c.id));
    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;
    const goldScore = goldIndex === -1 ? null : (result.memories[goldIndex]?.score.total ?? null);
    const distractorScore =
      distractorIndex === -1 ? null : (result.memories[distractorIndex]?.score.total ?? null);
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
    const result = await options.runtime.recall(ctx, { text: c.utterance });
    const topMemory = result.memories[0];
    // ⚠ **全候補の externalId を解決する**（top1 だけではない）——`protectedFacts` が
    // 複数件のとき、1位以外に居る保護対象のスコアも `protectedFactScore` に使うため
    // （ADR 0291 §5.5、ADR 0321）。
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const topExternalId = resolvedExternalIds[0] ?? null;
    const protectedIds = c.protectedFacts.map((_, i) => correctionProtectedExternalId(c.id, i));
    const protectedAtTop = topExternalId !== null && protectedIds.includes(topExternalId);
    const protectedFactScore = minProtectedFactScore(
      result.memories,
      resolvedExternalIds,
      protectedIds,
    );
    const topScore = topMemory?.score.total ?? null;
    abstains.push({
      caseId: c.id,
      kind: c.kind,
      protectedAtTop,
      abstained: topMemory === undefined,
      topScore,
      topDigest: topMemory?.digest ?? null,
      protectedFactScore,
      intrusionMargin: computeIntrusionMargin(topScore, protectedAtTop, protectedFactScore),
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
  };
}

// ---------------------------------------------------------------------------
// 集計（純関数。arm を動かさずに検査できるよう分けてある）
// ---------------------------------------------------------------------------

export interface CorrectionCandidateSummary {
  hitCount: number;
  /** k → 当たった件数。k は 1/3/5/10。 */
  hitAtK: Record<number, number>;
  mrr: number;
  distractorBeatsGoldCount: number;
  goldScoreMin: number | null;
  goldScoreMax: number | null;
  abstainCount: number;
  /** ⛔ 失効させてはいけない事実を1位に置いた件数（**深い誤爆**）。 */
  protectedAtTopCount: number;
  /** 1位は返ったが、守るべき事実ではなかった件数（**浅い誤爆**）。 */
  shallowMisfireCount: number;
  /** 1件も返さなかった件数（**棄権**）。 */
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
    `  intrusionMargin(topScore−protectedFactScore、深い誤爆のみ): ` +
      formatMarginStats(report.intrusionMarginStats),
  );
  lines.push("");
  lines.push(
    "⚠ この数字は、この母集合・この provider・この規模についてのものである。代表性は主張しない。",
  );
  return lines.join("\n");
}
