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

/**
 * ⚠ **この輸出は re-export である**——`maxNonProtectedScore`/`computeProtectionMargin`
 * の実装本体は ADR 0333 §4.2 の推奨を実装する際に `correction-candidate-arm.ts`
 * （本番の `runCorrectionCandidateArm` も同じ式を必要とするため）へ移した。二重管理を
 * 避けるため、この器は元の輸出名をそのまま再輸出するだけにしてある——このファイルの
 * 既存テスト（`__tests__/intrusion-margin-candidates.test.ts`）の import 先を
 * 変えずに済む。式そのものは1文字も変えていない。
 */
export { computeProtectionMargin, maxNonProtectedScore };

/**
 * Issue #109 残件C（マネージャー依頼）——ADR 0291 §5.5/ADR 0321 が決めた
 * `intrusionMargin`（B群、深い誤爆のときだけ定義）の**定義の候補**を、同じ53件
 * （A群21・B群32）の実測で比べるための純関数と手動測定。
 *
 * ⚠ **当初「`correction-candidate-arm.ts` は1文字も変えない」という制約の下で
 * 書かれたファイルである**（ADR 0333 の測定・比較フェーズ）。ADR 0333 §4.2 の
 * 推奨（案2）を実際に出荷する本作業では、`correction-candidate-arm.ts` 側に
 * 同じ式（`protectionMargin`）を本番の一部として追加した——**この上の制約は
 * その時点（比較のためだけの測定）にだけ適用されていたものであり、今は
 * 上書きされている**。このファイル自身（`measureIntrusionMarginCandidates` 以下）は
 * 変更していない（2回 `recall()` する独自の測定経路も、既存テストもそのまま）。
 *
 * **現状（案0・現行）**: `intrusionMargin = topScore − protectedFactScore`。
 * `protectedAtTop === true`（深い誤爆）のときだけ定義し、それ以外（誤爆(浅)・棄権）は
 * `null`。`protectedFacts` が0〜1件のケースでは、深い誤爆のとき `topScore` と
 * `protectedFactScore` が必ず同じ記憶を指すため、**値は常に0になる**
 * （ADR 0321 §4 が実測として記録済み）。
 *
 * **この器が追加で測る候補（案1/2の数値そのもの）**: `protectionMargin =
 * protectedFactScore − topNonProtectedScore`。`topNonProtectedScore` は「保護対象
 * ではない候補（＝訂正に使われうる候補）の中で最もスコアが高いもの」——深い誤爆・
 * 誤爆(浅)の**両方**で定義され（`protectedFacts` が1件以上返っている限り）、
 * **符号が意味を持つ**:
 *
 * - 正（0より大きい）: 保護対象のスコアが、最有力の「訂正に使われうる候補」より
 *   高い。これは**深い誤爆側**で起きる（保護対象そのものが1位に来ているなら、
 *   保護対象のスコアは他のどの候補よりも高い）。
 * - 負（0より小さい）: 保護対象のスコアが、最有力の「訂正に使われうる候補」より
 *   低い。これは**誤爆(浅)側**で起きる（1位が保護対象ではない＝何らかの
 *   非保護候補が保護対象を上回っている）。絶対値が大きいほど、保護対象が
 *   「訂正に使われうる候補」から大きく引き離されている（誤爆(浅)の中でも
 *   「際どく浅い」か「大きく浅い」かを連続値で読める）。
 * - `null`: `protectedFacts` が0件（曖昧ケース、守るべき相手がそもそも記憶に無い）、
 *   または `protectedFacts` はあるが1件も候補として返らなかった場合。
 *
 * ⚠ **「案1」と「案2」は、この器では数値としては同一の式である。**両者が分かれるのは
 * 「どう出荷するか」——案1は `intrusionMargin` 自体の定義域を広げる（既存フィールドを
 * 書き換える、破壊的）。案2は `intrusionMargin` を凍結したまま、別名
 * `protectionMargin` を新設する（非破壊的、`intrusionMargin` は非推奨として残す）。
 * この器は数値の比較までを行い、出荷方式の選択（案1 vs 案2）は ADR 側の判断に委ねる
 * （結果メモにその論点を書く）。
 */

/**
 * `recall()` を2回連続で呼んだときに、`decay`/`freshness` が壁時計の経過（数ms）を
 * 拾って下位桁が揺れることを、ADR 0232/0321 がすでに実測・記録している
 * （ADR 0321 §3.2「6桁目程度のわずかな揺れ」）。**この器の `measureIntrusionMarginCandidates`
 * も同じ理由で2回 `recall()` を呼ぶため、同じ揺れが起きる**——これは実装の欠陥では
 * なく壁時計依存の既知の挙動であり、`consistencyMismatches` を「本当の食い違い」
 * だけに絞るための許容誤差である。**実測で観測された揺れの大きさ（約1e-6〜1e-7）より
 * 十分大きく、かつ `computeProtectionMargin`/`computeIntrusionMargin` が意味を持つ
 * 差（既存の margin 分布は 1e-2 桁）より十分小さい値を選んだ。**
 */
export const SCORE_JITTER_EPSILON = 1e-4;

export function scoresMatchWithinJitter(a: number | null, b: number | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a - b) <= SCORE_JITTER_EPSILON;
}

/** B群1件ぶんの、候補比較用の測定結果。 */
export interface AbstainCaseCandidateMeasurement {
  caseId: string;
  kind: CorrectionAbstainCase["kind"];
  protectedAtTop: boolean;
  abstained: boolean;
  topScore: number | null;
  /** 既存の定義（`minProtectedFactScore` の値）。案0/1/2 すべてがこれを土台にする。 */
  protectedFactScore: number | null;
  /** 新規: 訂正に使われうる候補の中の最有力スコア。 */
  topNonProtectedScore: number | null;
  /** 案0（現行）。`correction-candidate-arm.ts` の `computeIntrusionMargin` をそのまま呼ぶ。 */
  intrusionMarginCurrent: number | null;
  /** 案1/2（数値は同一）。 */
  protectionMargin: number | null;
}

/**
 * 符号付きの分布要約（`identifier-arm.ts` の `MarginStats` と違い `max` を持つ——
 * `protectionMargin` は符号が意味を持つため、正負の広がりを読むのに `max` が要る）。
 */
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
  /** ⚠ この run で初めて使うテナントを渡すこと（`correction-candidate-arm.ts` と同じ理由）。 */
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
  /** `runCorrectionCandidateArm`（未変更）の生の出力。案0の値・A群の参考値はここから読む。 */
  report: CorrectionCandidateReport;
  /** B群の拡張測定（案0・案1/2 を同じ行に並べたもの）。 */
  measurements: AbstainCaseCandidateMeasurement[];
  /** `measurements[].intrusionMarginCurrent` の分布（案0、`max` 付き）。 */
  intrusionMarginCurrentStats: SignedMarginStats;
  /** `measurements[].protectionMargin` の分布（案1/2）。 */
  protectionMarginStats: SignedMarginStats;
  /** `protectionMargin` を「深い誤爆のケースだけ」で見た分布。 */
  protectionMarginStatsDeepOnly: SignedMarginStats;
  /** `protectionMargin` を「誤爆(浅)のケースだけ」で見た分布。 */
  protectionMarginStatsShallowOnly: SignedMarginStats;
  /** 内部整合性チェックで見つかった不一致（空なら整合していた）。 */
  consistencyMismatches: string[];
}

/**
 * 手動測定の本体。**`runCorrectionCandidateArm`（既存・未変更）を呼んで ingest と
 * A群/B群の標準測定を済ませ**、その後 B群だけもう一度 `recall()` を呼んで
 * （読み取り専用・副作用無し）`topNonProtectedScore` を追加で採る。
 *
 * ⚠ **B群は2回 `recall()` される**（1回目は `runCorrectionCandidateArm` の内部、
 * 2回目はこの関数）。`recall()` は読み取り専用であり、同じテナントに対して
 * 2回呼んでも状態は変わらない——ただし決定的であるはずの値（`topScore`・
 * `protectedAtTop`・`protectedFactScore`）が2回の呼び出しで食い違わないかを
 * `consistencyMismatches` に記録し、**食い違いを検出だけして確定はしない**
 * （AGENTS.md「機械には検出まで」の適用——値が一致しないときに、どちらが正しいかを
 * この関数が勝手に決めない）。
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
    // association: null — 連想枠が既定 on になった（ADR 0337。オーナーが選択肢(あ)を選んだ、ask_human ac5953d1、2026-09-25）
    // でも、この bench（intrusion margin の候補生成）の基準線を動かさない。
    const result = await options.runtime.recall(ctx, { text: c.utterance, association: null });
    const topMemory = result.memories[0];
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const protectedIds = c.protectedFacts.map((_, i) => correctionProtectedExternalId(c.id, i));
    const topExternalId = resolvedExternalIds[0] ?? null;
    const protectedAtTop = topExternalId !== null && protectedIds.includes(topExternalId);
    const protectedFactScore = minProtectedFactScore(
      result.memories,
      resolvedExternalIds,
      protectedIds,
    );
    const topNonProtectedScore = maxNonProtectedScore(
      result.memories,
      resolvedExternalIds,
      protectedIds,
    );
    const topScore = topMemory?.score.total ?? null;
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
