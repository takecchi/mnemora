import type { AnswerVerdict } from "../answer-case.js";
import type { TimeWeightingPolicy } from "@mnemora/core";

export interface ChangedPair {
  caseId: string;
  policy: TimeWeightingPolicy;
}

export function formatPairKey(pair: ChangedPair): string {
  return `${pair.caseId}/${pair.policy}`;
}

export function chooseTrialCount(pairsCount: number, maxPairedCalls: number, capN: number): number {
  if (pairsCount <= 0) {
    return 0;
  }
  const bound = Math.floor(maxPairedCalls / (2 * pairsCount));
  return Math.max(0, Math.min(capN, bound));
}

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

/** `AnswerVerdict` を二値へ畳む。`indeterminate` は「正解ではない」側に入れる。正解に混ぜると、判定不能な答えを「正しく答えた」と誤魔化すことになる。 */
export function isCorrect(verdict: AnswerVerdict): boolean {
  return verdict === "pass";
}

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

export interface SignTestSummary {
  onWinsOffLoses: number;
  offWinsOnLoses: number;
  concordant: number;
  discordantTotal: number;
  pValue: number;
}

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
