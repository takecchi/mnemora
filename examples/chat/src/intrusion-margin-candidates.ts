import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
import type { CorrectionAbstainCase } from "./correction-case.js";
import { correctionProtectedExternalId } from "./correction-case.js";
import {
  computeIntrusionMargin,
  computeProtectionMargin,
  maxNonProtectedScore,
  minProtectedFactScore,
  runCorrectionCandidateArm,
} from "./correction-candidate-arm.js";
import type { CorrectionCandidateReport } from "./correction-candidate-arm.js";
import { resolveExternalId } from "./provenance-trace.js";
import type { ProviderMode } from "./providers.js";
import { requireMeasuredTotal } from "./recalled-score.js";

/** re-export。実装本体は `correction-candidate-arm.ts` にある（本番も同じ式を使うため）。既存テストの import 先を変えずに済むよう、元の輸出名を残す。 */
export { computeProtectionMargin, maxNonProtectedScore };

/**
 * `intrusionMargin` の定義の候補を同じ53件（A群21・B群32）の実測で比べる純関数と手動測定。
 *
 * 追加で測る `protectionMargin = protectedFactScore − topNonProtectedScore` は符号が意味を持つ。
 * 正は深い誤爆側、負は誤爆(浅)側で、`null` は `protectedFacts` が0件、または1件も候補として返らなかった場合。
 * 案1と案2は数値としては同一の式で、出荷方式の選択（既存フィールドを書き換えるか別名を足すか）は ADR 側に委ねる。
 */

/**
 * `recall()` を2回呼ぶと、`decay`/`freshness` が壁時計を拾って下位桁が揺れる（実測で約1e-6〜1e-7）。
 * `consistencyMismatches` を本当の食い違いだけに絞るための許容誤差で、揺れより十分大きく、
 * margin の差（1e-2 桁）より十分小さい値を選んだ。
 */
export const SCORE_JITTER_EPSILON = 1e-4;

export function scoresMatchWithinJitter(a: number | null, b: number | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a - b) <= SCORE_JITTER_EPSILON;
}

export interface AbstainCaseCandidateMeasurement {
  caseId: string;
  kind: CorrectionAbstainCase["kind"];
  protectedAtTop: boolean;
  abstained: boolean;
  topScore: number | null;
  protectedFactScore: number | null;
  topNonProtectedScore: number | null;
  intrusionMarginCurrent: number | null;
  protectionMargin: number | null;
}

/** 符号付きの分布要約。`protectionMargin` は符号が意味を持つので、正負の広がりを読むために `max` を持つ。 */
export interface SignedMarginStats {
  count: number;
  mean: number | null;
  stdDev: number | null;
  min: number | null;
  max: number | null;
}

export function computeSignedMarginStats(values: readonly (number | null)[]): SignedMarginStats {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) {
    return { count: 0, mean: null, stdDev: null, min: null, max: null };
  }
  const mean = present.reduce((sum, v) => sum + v, 0) / present.length;
  const min = Math.min(...present);
  const max = Math.max(...present);
  let stdDev: number | null = null;
  if (present.length >= 2) {
    const variance = present.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (present.length - 1);
    stdDev = Math.sqrt(variance);
  }
  return { count: present.length, mean, stdDev, min, max };
}

export interface IntrusionMarginCandidateOptions {
  /** この run で初めて使うテナントを渡すこと。 */
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  hitCases: Parameters<typeof runCorrectionCandidateArm>[0]["hitCases"];
  abstainCases: readonly CorrectionAbstainCase[];
  haystackSize?: number;
}

export interface IntrusionMarginCandidateResult {
  report: CorrectionCandidateReport;
  measurements: AbstainCaseCandidateMeasurement[];
  intrusionMarginCurrentStats: SignedMarginStats;
  protectionMarginStats: SignedMarginStats;
  protectionMarginStatsDeepOnly: SignedMarginStats;
  protectionMarginStatsShallowOnly: SignedMarginStats;
  consistencyMismatches: string[];
}

/**
 * 手動測定の本体。B群は2回 `recall()` される（`runCorrectionCandidateArm` の内部とこの関数）。
 * 決定的なはずの値が食い違ったら `consistencyMismatches` に記録するだけで、どちらが正しいかは勝手に決めない。
 */
export async function measureIntrusionMarginCandidates(
  options: IntrusionMarginCandidateOptions,
): Promise<IntrusionMarginCandidateResult> {
  const report = await runCorrectionCandidateArm({
    tenantId: options.tenantId,
    runtime: options.runtime,
    memoryStore: options.memoryStore,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    hitCases: options.hitCases,
    abstainCases: options.abstainCases,
    ...(options.haystackSize !== undefined ? { haystackSize: options.haystackSize } : {}),
  });

  const reportByCaseId = new Map(report.abstains.map((a) => [a.caseId, a]));
  const ctx: Ctx = { tenantId: options.tenantId };
  const consistencyMismatches: string[] = [];
  const measurements: AbstainCaseCandidateMeasurement[] = [];

  for (const c of options.abstainCases) {
    // association: null — 連想枠が既定 on でも、この bench の基準線を動かさない。
    const result = await options.runtime.recall(ctx, { text: c.utterance, association: null });
    const topMemory = result.memories[0];
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const protectedIds = c.protectedFacts.map((_, i) => correctionProtectedExternalId(c.id, i));
    const topExternalId = resolvedExternalIds[0] ?? null;
    const protectedAtTop = topExternalId !== null && protectedIds.includes(topExternalId);
    // 純関数が `{ score: { total: number } }[]` の形を受けるまま保つため、ここで total を取り出す（association: null なので affinityMeasured は必ず true）。
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
    const abstained = topMemory === undefined;

    const priorOutcome = reportByCaseId.get(c.id);
    if (priorOutcome !== undefined) {
      if (priorOutcome.protectedAtTop !== protectedAtTop) {
        consistencyMismatches.push(
          `${c.id}: protectedAtTop が1回目(${String(priorOutcome.protectedAtTop)})と` +
            `2回目(${String(protectedAtTop)})で食い違った`,
        );
      }
      if (!scoresMatchWithinJitter(priorOutcome.topScore, topScore)) {
        consistencyMismatches.push(
          `${c.id}: topScore が1回目(${String(priorOutcome.topScore)})と` +
            `2回目(${String(topScore)})で ${String(SCORE_JITTER_EPSILON)} を超えて食い違った`,
        );
      }
      if (!scoresMatchWithinJitter(priorOutcome.protectedFactScore, protectedFactScore)) {
        consistencyMismatches.push(
          `${c.id}: protectedFactScore が1回目(${String(priorOutcome.protectedFactScore)})と` +
            `2回目(${String(protectedFactScore)})で ${String(SCORE_JITTER_EPSILON)} を超えて食い違った`,
        );
      }
    } else {
      consistencyMismatches.push(`${c.id}: 1回目(runCorrectionCandidateArm)の結果に見当たらない`);
    }

    measurements.push({
      caseId: c.id,
      kind: c.kind,
      protectedAtTop,
      abstained,
      topScore,
      protectedFactScore,
      topNonProtectedScore,
      intrusionMarginCurrent: computeIntrusionMargin(topScore, protectedAtTop, protectedFactScore),
      protectionMargin: computeProtectionMargin(protectedFactScore, topNonProtectedScore),
    });
  }

  return {
    report,
    measurements,
    intrusionMarginCurrentStats: computeSignedMarginStats(
      measurements.map((m) => m.intrusionMarginCurrent),
    ),
    protectionMarginStats: computeSignedMarginStats(measurements.map((m) => m.protectionMargin)),
    protectionMarginStatsDeepOnly: computeSignedMarginStats(
      measurements.filter((m) => m.protectedAtTop).map((m) => m.protectionMargin),
    ),
    protectionMarginStatsShallowOnly: computeSignedMarginStats(
      measurements.filter((m) => !m.protectedAtTop && !m.abstained).map((m) => m.protectionMargin),
    ),
    consistencyMismatches,
  };
}
