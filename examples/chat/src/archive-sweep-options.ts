import type { EnvLike } from "./providers.js";
import { DEFAULT_BUDGET_LADDER, DEFAULT_RECALL_LIMIT } from "./consolidation-cost-options.js";

/** 環境変数のパース。`budgetLadder`/`recallLimit` の既定は `consolidation-cost-options.ts` の値を流用する。書き写すと片方だけ直したときにずれる。 */

export const DEFAULT_HALF_LIFE_HOURS = 1;

export const DEFAULT_MARGIN_HOURS = 0.5;

export const DEFAULT_SWEEP_LIMIT = 1000;

export interface ArchiveSweepCostOptions {
  halfLifeHours: number;
  marginHours: number;
  sweepLimit: number;
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

function parsePositiveFloat(varName: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${varName} には正の数値を指定すること(実際: "${value}")。`);
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

export function parseArchiveSweepCostOptions(env: EnvLike): ArchiveSweepCostOptions {
  return {
    halfLifeHours: parsePositiveFloat(
      "MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS",
      env.MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS,
      DEFAULT_HALF_LIFE_HOURS,
    ),
    marginHours: parsePositiveFloat(
      "MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS",
      env.MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS,
      DEFAULT_MARGIN_HOURS,
    ),
    sweepLimit: parsePositiveInt(
      "MNEMORA_ARCHIVE_SWEEP_LIMIT",
      env.MNEMORA_ARCHIVE_SWEEP_LIMIT,
      DEFAULT_SWEEP_LIMIT,
    ),
    budgetLadder: parseBudgetLadder(
      "MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER",
      env.MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER,
    ),
    recallLimit: parsePositiveInt(
      "MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT",
      env.MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT,
      DEFAULT_RECALL_LIMIT,
    ),
  };
}
