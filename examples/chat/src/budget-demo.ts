import type { Ctx, RecallResult, Runtime } from "@mnemora/core";
import { queryRecall } from "./mnemora-path.js";
import type { Conversation } from "./scenario.js";

/**
 * 「予算あり/なし」対比デモ。デモ本体（`runBudgetDemo`）・機械判定（`checkBudgetDemo`）・印字を分けてある。
 * `__tests__` から呼べるようにするためで、印字はここでは行わない。
 *
 * 北極星の主測定（`compare`/`retrieval`）には関わらない。`compare.ts`/`retrieval-quality.ts`/`probe-set.ts`/`naive-path.ts` を import しない。
 * `ctx` に `conversation` が ingest 済みであることを前提にする（`queryRecall` と同じ）。
 */

export const TINY_BUDGET_CHARS = 60;

export interface BudgetDemoResult {
  withoutBudget: RecallResult;
  withBudget: RecallResult;
}

export async function runBudgetDemo(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
): Promise<BudgetDemoResult> {
  const withoutBudget = await queryRecall(runtime, ctx, conversation);
  const withBudget = await queryRecall(runtime, ctx, conversation, {
    budget: { maxMemoryChars: TINY_BUDGET_CHARS },
  });
  return { withoutBudget, withBudget };
}

function budgetTruncationStage(result: RecallResult) {
  return result.explain.stages.find((s) => s.stage === "budget_truncation");
}

function hasBudgetDropped(result: RecallResult): boolean {
  return result.omitted.some((o) => o.kind === "budget_dropped");
}

export interface BudgetDemoCheck {
  withoutBudgetIsNonEmpty: boolean;
  /**
   * budget を渡すと、memories tier（`usage.byTier.digest`）が実際に減るか。
   *
   * `usage.chars` ではなく `byTier.digest` で比べる。budget で `memories` から押し出された Memory は
   * 目次帯の対象になり、`usage.chars` は budget を締めても増えることがあるため（docs/recall.md §5）。
   */
  withBudgetIsSmaller: boolean;
  withBudgetHasDroppedOmission: boolean;
  withoutBudgetHasNoBudgetDropped: boolean;
  /**
   * budget 無しの経路で、段4（`budget_truncation`）が「適用されなかった」と名乗っているか。
   * 隠れた既定上限が無いことを名指しで検査する。
   */
  withoutBudgetHasNoAppliedTruncation: boolean;
  withBudgetFitsDeclaredCharBudget: boolean;
  withBudgetIsNotExceeded: boolean;
}

export function checkBudgetDemo(result: BudgetDemoResult): BudgetDemoCheck {
  const withoutBudgetTrace = budgetTruncationStage(result.withoutBudget);
  return {
    withoutBudgetIsNonEmpty: result.withoutBudget.memories.length > 0,
    withBudgetIsSmaller:
      result.withBudget.usage.byTier.digest < result.withoutBudget.usage.byTier.digest,
    withBudgetHasDroppedOmission: hasBudgetDropped(result.withBudget),
    withoutBudgetHasNoBudgetDropped: !hasBudgetDropped(result.withoutBudget),
    withoutBudgetHasNoAppliedTruncation: withoutBudgetTrace?.detail?.budgetApplied === false,
    withBudgetFitsDeclaredCharBudget: result.withBudget.usage.byTier.digest <= TINY_BUDGET_CHARS,
    withBudgetIsNotExceeded: result.withBudget.usage.budgetExceeded === false,
  };
}
