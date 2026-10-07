import type { EnvLike } from "./providers.js";

/**
 * `consolidation-cost` サブコマンドが読む環境変数のパース（純関数）。
 * 環境変数が無ければ既定値、不正な値なら例外。黙って既定へ倒れない。
 */

export const DEFAULT_GROUP_SIZE = 5;

/**
 * `recall()` の `budget.maxMemoryTokens` の階段。
 *
 * 下の段を細かくしてあるのは、粗い段だと probe の大半が最下段で gold を載せてしまい、
 * 主指標（gold を載せるのに要った最小の予算）が床に張り付いて分解能を失ったため。
 * 上の段は落とさない。`recalledActiveShare` が 1.0 へ張り付く（「全部載せる」へ退化する）ことを見せるのは上の段。
 */
export const DEFAULT_BUDGET_LADDER: readonly number[] = [8, 16, 24, 32, 48, 64, 128, 256, 512];

export const DEFAULT_RECALL_LIMIT = 50;

export interface ConsolidationCostOptions {
  groupSize: number;
  budgetLadder: number[];
  recallLimit: number;
}

function parsePositiveInt(varName: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${varName} には正の整数を指定すること(実際: "${value}")。`);
  }
  return parsed;
}

function parseBudgetLadder(varName: string, value: string | undefined): number[] {
  if (value === undefined || value === "") {
    return [...DEFAULT_BUDGET_LADDER];
  }
  const parts = value.split(",").map((s) => s.trim());
  const parsed = parts.map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${varName} の各値は正の整数であること(実際: "${value}")。`);
    }
    return n;
  });
  if (parsed.length === 0) {
    throw new Error(`${varName} には少なくとも1つの値が要る(実際: "${value}")。`);
  }
  return parsed;
}

export function parseConsolidationCostOptions(env: EnvLike): ConsolidationCostOptions {
  const groupSize = parsePositiveInt(
    "MNEMORA_CONSOLIDATION_GROUP_SIZE",
    env.MNEMORA_CONSOLIDATION_GROUP_SIZE,
    DEFAULT_GROUP_SIZE,
  );
  if (groupSize < 2) {
    // `splitIntoConsolidationGroups` 自身が同じ下限を要求するので、ここで先に落とし、意味の無い実行を始めない。
    throw new Error(
      `MNEMORA_CONSOLIDATION_GROUP_SIZE には2以上の整数を指定すること(実際: "${env.MNEMORA_CONSOLIDATION_GROUP_SIZE}")。`,
    );
  }
  return {
    groupSize,
    budgetLadder: parseBudgetLadder(
      "MNEMORA_CONSOLIDATION_BUDGET_LADDER",
      env.MNEMORA_CONSOLIDATION_BUDGET_LADDER,
    ),
    recallLimit: parsePositiveInt(
      "MNEMORA_CONSOLIDATION_RECALL_LIMIT",
      env.MNEMORA_CONSOLIDATION_RECALL_LIMIT,
      DEFAULT_RECALL_LIMIT,
    ),
  };
}
