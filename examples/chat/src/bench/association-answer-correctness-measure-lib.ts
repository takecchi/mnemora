import type { AnswerVerdict } from "../answer-case.js";
import type { TimeWeightingPolicy } from "@mnemora/core";

/**
 * `association-answer-correctness-measure.ts`（ADR 0337 追記2026-09-26「回答の正誤」）が
 * 使う純関数群。**このファイルは DB・provider を一切要求しない**——
 * `association-default-on-measure-lib.ts` と同じ分担（本体側は DB 必須の
 * オーケストレーションだけを持ち、計算・整形はここに集める）。
 *
 * 依頼元: クローン miku（オーナーではない）。目的: 連想枠（association）の
 * off（null）/on（`{maxCount:10}`、`DEFAULT_RECALL_ASSOCIATION`）で
 * **`answer-time-weighting` の回答の正誤**が変わるかを、実 API（gpt-4o-mini）で
 * 少数回だけ測るための組み立て。
 */

// ---------------------------------------------------------------------------
// off/on10 でプロンプトが変わった「組」（ケース × 方針）
// ---------------------------------------------------------------------------

export interface ChangedPair {
  caseId: string;
  policy: TimeWeightingPolicy;
}

/** `"<caseId>/<policy>"` の形（表示・キー用）。 */
export function formatPairKey(pair: ChangedPair): string {
  return `${pair.caseId}/${pair.policy}`;
}

// ---------------------------------------------------------------------------
// 呼び出し回数の予算から試行回数 n を決める
// ---------------------------------------------------------------------------

/**
 * 「変わる組数 × 2(off/on) × n ≤ maxPairedCalls」を満たす最大の n を、
 * `capN` を上限として選ぶ。
 *
 * `pairsCount === 0` なら 0 を返す（対象が無いので試行しようがない——
 * 呼び出し側はこの場合、実 API 段そのものをスキップすること）。
 */
export function chooseTrialCount(pairsCount: number, maxPairedCalls: number, capN: number): number {
  if (pairsCount <= 0) {
    return 0;
  }
  const bound = Math.floor(maxPairedCalls / (2 * pairsCount));
  return Math.max(0, Math.min(capN, bound));
}

// ---------------------------------------------------------------------------
// 呼び出し回数のハードリミット
// ---------------------------------------------------------------------------

/** 呼び出し前にこれを超えるかを確認する。超えるなら例外——呼ばずに止める。 */
export function assertWithinHardCallLimit(
  currentCount: number,
  hardLimit: number,
  context: string,
): void {
  if (currentCount + 1 > hardLimit) {
    throw new Error(
      `assertWithinHardCallLimit: 実 API 呼び出しがハードリミット(${hardLimit})に達する` +
        `ため、これ以上呼ばずに止める（${context}、現在の呼び出し済み件数=${currentCount}）。`,
    );
  }
}

// ---------------------------------------------------------------------------
// 正誤の二値化（pass のみを正解とする。fail/indeterminate は「正解ではない」側）
// ---------------------------------------------------------------------------

/**
 * `AnswerVerdict`（pass/fail/indeterminate の三値）を二値へ畳む。
 *
 * **`indeterminate` を「正解ではない」側に入れる**——符号検定/McNemar は二値の
 * 一致/不一致しか扱えない。indeterminate を「正解」に混ぜると、モデルが判定不能な
 * 答えを返しただけのケースを「正しく答えた」と誤魔化すことになるため、pass 以外は
 * すべて「不正解側」として畳む（保守的な選択。この畳み方自体を ADR 追記に明記する）。
 */
export function isCorrect(verdict: AnswerVerdict): boolean {
  return verdict === "pass";
}

// ---------------------------------------------------------------------------
// 対にした試行1件
// ---------------------------------------------------------------------------

export interface PairedTrialOutcome {
  pair: ChangedPair;
  trial: number;
  offVerdict: AnswerVerdict;
  onVerdict: AnswerVerdict;
}

export interface PairAggregate {
  pair: ChangedPair;
  n: number;
  offPassCount: number;
  onPassCount: number;
}

/** `PairedTrialOutcome[]` を組ごとの off/on 正答数へ畳む。 */
export function aggregateByPair(outcomes: readonly PairedTrialOutcome[]): PairAggregate[] {
  const byKey = new Map<string, PairAggregate>();
  for (const o of outcomes) {
    const key = formatPairKey(o.pair);
    const existing = byKey.get(key);
    const offPass = isCorrect(o.offVerdict) ? 1 : 0;
    const onPass = isCorrect(o.onVerdict) ? 1 : 0;
    if (existing === undefined) {
      byKey.set(key, { pair: o.pair, n: 1, offPassCount: offPass, onPassCount: onPass });
    } else {
      existing.n += 1;
      existing.offPassCount += offPass;
      existing.onPassCount += onPass;
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// 符号検定（McNemar の exact 二項検定）
// ---------------------------------------------------------------------------

export interface SignTestSummary {
  /** off=不正解 → on=正解 の件数（on が勝った側）。 */
  onWinsOffLoses: number;
  /** off=正解 → on=不正解 の件数（off が勝った側）。 */
  offWinsOnLoses: number;
  /** 両方一致（正解同士・不正解同士）の件数。検定には使わない。 */
  concordant: number;
  /** 不一致件数の合計（`onWinsOffLoses + offWinsOnLoses`）。 */
  discordantTotal: number;
  /** two-sided exact 二項検定（p=0.5）の p 値。不一致が無ければ 1。 */
  pValue: number;
}

/** `n` 回中 `k` 回以下（または以上）になる二項確率の和。`p=0.5` 固定（符号検定）。 */
function binomialCoefficient(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

function binomialTailAtMost(n: number, k: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i += 1) {
    sum += binomialCoefficient(n, i);
  }
  return sum / 2 ** n;
}

/**
 * two-sided exact 二項検定（符号検定 / McNemar の exact 版）の p 値。
 * `p=0.5` の下で、観測した不一致の偏り（`min(b,c)` 回以下になる確率）を両側に倍にする
 * （標準的な exact McNemar 検定の定義。`n=0`——不一致が無ければ p=1）。
 */
export function exactSignTestPValue(onWinsOffLoses: number, offWinsOnLoses: number): number {
  const n = onWinsOffLoses + offWinsOnLoses;
  if (n === 0) {
    return 1;
  }
  const k = Math.min(onWinsOffLoses, offWinsOnLoses);
  const oneSided = binomialTailAtMost(n, k);
  return Math.min(1, oneSided * 2);
}

export function summarizeSignTest(outcomes: readonly PairedTrialOutcome[]): SignTestSummary {
  let onWinsOffLoses = 0;
  let offWinsOnLoses = 0;
  let concordant = 0;
  for (const o of outcomes) {
    const off = isCorrect(o.offVerdict);
    const on = isCorrect(o.onVerdict);
    if (off === on) {
      concordant += 1;
    } else if (on && !off) {
      onWinsOffLoses += 1;
    } else {
      offWinsOnLoses += 1;
    }
  }
  const discordantTotal = onWinsOffLoses + offWinsOnLoses;
  return {
    onWinsOffLoses,
    offWinsOnLoses,
    concordant,
    discordantTotal,
    pValue: exactSignTestPValue(onWinsOffLoses, offWinsOnLoses),
  };
}

// ---------------------------------------------------------------------------
// 全体の正答率
// ---------------------------------------------------------------------------

export interface OverallRate {
  passCount: number;
  total: number;
  rate: number;
}

export function overallRate(verdicts: readonly AnswerVerdict[]): OverallRate {
  const passCount = verdicts.filter((v) => isCorrect(v)).length;
  const total = verdicts.length;
  return { passCount, total, rate: total === 0 ? 0 : passCount / total };
}
