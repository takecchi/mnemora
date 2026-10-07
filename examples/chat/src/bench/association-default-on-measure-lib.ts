import type { RecallAssociationQuery } from "@mnemora/core";

export type AssociationLevelKey = "off" | "on5" | "on10" | "on20";

export interface AssociationLevel {
  key: AssociationLevelKey;
  label: string;
  association: RecallAssociationQuery | null;
}

export const ASSOCIATION_LEVELS: readonly AssociationLevel[] = [
  { key: "off", label: "off(association: null)", association: null },
  { key: "on5", label: "on(maxCount:5)", association: { maxCount: 5 } },
  { key: "on10", label: "on(maxCount:10, 既定と同じ値)", association: { maxCount: 10 } },
  { key: "on20", label: "on(maxCount:20)", association: { maxCount: 20 } },
];

export function tallyStrings(values: readonly string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const value of values) {
    tally[value] = (tally[value] ?? 0) + 1;
  }
  return tally;
}

/**
 * `tallyStrings` の結果に、`keys` の全部の値を（無ければ0で）埋める。`buildNumberDiffTable` は欄名の完全一致を要求するので、
 * 片方にしか出ない `PairOutcome` があると例外になる。値は有限の union なので、出なかった値は0件で確定する。
 */
export function fillMissingKeysWithZero(
  tally: Readonly<Record<string, number>>,
  keys: readonly string[],
): Record<string, number> {
  const filled: Record<string, number> = {};
  for (const key of keys) {
    filled[key] = tally[key] ?? 0;
  }
  return filled;
}

const PROMPT_INDEX_LINE_PATTERN = /\(索引: スコープ内 (\d+) 件のうち (\d+) 件を提示\)/;

/**
 * mnemora 側プロンプト文字列から、`buildMnemoraPrompt` が末尾に置く索引行を読み取る。文字列から読むのは、
 * `AnswerPathMeasurement` 等が `RecallResult` を公開しておらず、bench 側を変更して内訳を公開する代わりに
 * 既に持っている値を読むだけにするため。一致しなければ `null`（推測で埋めない）。
 */
export function parsePromptIndexLine(
  promptText: string,
): { totalInScope: number; returned: number } | null {
  const match = PROMPT_INDEX_LINE_PATTERN.exec(promptText);
  if (match === null) {
    return null;
  }
  return { totalInScope: Number(match[1]), returned: Number(match[2]) };
}

export interface NumberDiffCell {
  baseline: number;
  variant: number;
  absoluteDiff: number;
  percentOfBaseline: number | null;
}

/** 2つの「欄名→数値」マップを同じ欄名どうしで比較する。欄名の集合が違えば `Error`。黙って0で埋めると「元々0件」と「比較対象に無い」が区別できなくなる。 */
export function buildNumberDiffTable(
  baseline: Readonly<Record<string, number>>,
  variant: Readonly<Record<string, number>>,
): Record<string, NumberDiffCell> {
  const baselineKeys = Object.keys(baseline);
  const variantKeys = Object.keys(variant);
  const missingInVariant = baselineKeys.filter((k) => !(k in variant));
  const missingInBaseline = variantKeys.filter((k) => !(k in baseline));
  if (missingInVariant.length > 0 || missingInBaseline.length > 0) {
    throw new Error(
      "buildNumberDiffTable: baseline/variant の欄名が一致しない " +
        `(baseline のみ: [${missingInVariant.join(", ")}], variant のみ: [${missingInBaseline.join(", ")}])`,
    );
  }
  const table: Record<string, NumberDiffCell> = {};
  for (const key of baselineKeys) {
    const b = baseline[key]!;
    const v = variant[key]!;
    table[key] = {
      baseline: b,
      variant: v,
      absoluteDiff: v - b,
      percentOfBaseline: b === 0 ? null : ((v - b) / b) * 100,
    };
  }
  return table;
}

export function formatNumberDiffCell(cell: NumberDiffCell): string {
  const sign = cell.absoluteDiff > 0 ? "+" : "";
  const percent =
    cell.percentOfBaseline === null ? "(基準0)" : `${sign}${cell.percentOfBaseline.toFixed(1)}%`;
  return `${cell.baseline} → ${cell.variant} (${sign}${cell.absoluteDiff}, ${percent})`;
}

/**
 * 指定した key を持つ欄を再帰的に取り除いた複製を返す。`Date` は ISO 文字列に写す。
 * 構造上毎回変わる欄（`tenantId`・`measuredAt`・`now` 等）まで一致を要求すると、決定的な実行を「一致しない」と誤報するため。
 */
export function redactVolatileFields(value: unknown, keys: readonly string[]): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactVolatileFields(v, keys));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(k)) {
        continue;
      }
      result[k] = redactVolatileFields(v, keys);
    }
    return result;
  }
  return value;
}

/** `redactVolatileFields` した上で構造的に一致するかを確かめる。`JSON.stringify` 比較なのでキー順序に依存する。同じ構築コードを通っていれば揃う。 */
export function sameAfterRedactingVolatileFields(
  a: unknown,
  b: unknown,
  volatileKeys: readonly string[],
): boolean {
  return (
    JSON.stringify(redactVolatileFields(a, volatileKeys)) ===
    JSON.stringify(redactVolatileFields(b, volatileKeys))
  );
}

export const KNOWN_VOLATILE_FIELD_NAMES: readonly string[] = [
  "tenantId",
  "armLabel",
  "measuredAt",
  "now",
  "commit",
  "usageReport",
  "drain",
];
