import type { RecallAssociationQuery } from "@mnemora/core";

/**
 * `association-default-on-measure.ts`(ADR 0337 追記2026-09-26)が使う純関数群。
 *
 * **このファイルは DB・provider を一切要求しない。**`vitest run
 * src/bench/__tests__/association-default-on-measure-lib.test.ts` で個別に検査できる
 * ——本体（`association-default-on-measure.ts`）側は DB 必須のオーケストレーションだけを
 * 持ち、計算・整形はここに集める(`consolidation-json.ts`/`archive-sweep-json.ts` が
 * ファイル I/O を持たない純関数だけを別ファイルに集めている前例と同じ分担)。
 */

// ---------------------------------------------------------------------------
// 連想枠の4段(off / on5 / on10(既定) / on20)
// ---------------------------------------------------------------------------

export type AssociationLevelKey = "off" | "on5" | "on10" | "on20";

export interface AssociationLevel {
  key: AssociationLevelKey;
  label: string;
  /** `recall()`/各 arm の `association` オプションへそのまま渡す値。 */
  association: RecallAssociationQuery | null;
}

/**
 * 4段の定義。**`maxCount` の値そのものはここが唯一の出所である**——
 * `packages/core` の `DEFAULT_RECALL_ASSOCIATION.maxCount`(10)・
 * `examples/chat` の `DEFAULT_MNEMORA_PATH_ASSOCIATION.maxCount`(10)は変えていない
 * (このファイルはそれらを読まない——`on10` の値 `10` は既定と一致することを
 * ADR 0337 追記の本文側で確認記録する)。
 */
export const ASSOCIATION_LEVELS: readonly AssociationLevel[] = [
  { key: "off", label: "off(association: null)", association: null },
  { key: "on5", label: "on(maxCount:5)", association: { maxCount: 5 } },
  { key: "on10", label: "on(maxCount:10, 既定と同じ値)", association: { maxCount: 10 } },
  { key: "on20", label: "on(maxCount:20)", association: { maxCount: 20 } },
];

// ---------------------------------------------------------------------------
// 文字列配列の集計(omittedKinds・PairOutcome 等、どの arm でも同じ形で使う)
// ---------------------------------------------------------------------------

/** 値ごとの出現回数。順序は初めて現れた順(`Object.keys` の反復順、V8 で保証される)。 */
export function tallyStrings(values: readonly string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const value of values) {
    tally[value] = (tally[value] ?? 0) + 1;
  }
  return tally;
}

/**
 * `tallyStrings` が返すマップに、`keys` に挙げた全部の値を(無ければ0で)埋める。
 *
 * **なぜ要るか**: `buildNumberDiffTable` は baseline/variant の欄名が完全に一致することを
 * 要求する(下のdoc参照)。連想枠 off では出ない `PairOutcome`(例: `"collapsed"`)が
 * on20 だけで出た場合、素の `tallyStrings` の結果は2つのマップで欄名が食い違い、
 * `buildNumberDiffTable` が例外になる。**「出なかった」は「0件だった」という
 * 実測そのもの**(推測ではない——`PairOutcome`/`Omission.kind` は有限の union であり、
 * 出なかった値は構造上0件で確定する)なので、0で埋めてよい。
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

// ---------------------------------------------------------------------------
// `buildMnemoraPrompt`(mnemora-path.ts)が末尾に置く索引行の読み取り
// ---------------------------------------------------------------------------

const PROMPT_INDEX_LINE_PATTERN = /\(索引: スコープ内 (\d+) 件のうち (\d+) 件を提示\)/;

/**
 * `answer-bench.ts`/`time-weighting-bench.ts` が組む mnemora 側プロンプト文字列から、
 * `buildMnemoraPrompt` が必ず末尾に置く索引行(`(索引: スコープ内 N 件のうち M 件を
 * 提示)`)を読み取る。
 *
 * **なぜ文字列から読むか**: `AnswerPathMeasurement`/`TimeWeightingPolicyResult` は
 * `RecallResult` 自体を公開していない(`promptSpec`/`prompt` という直列化済みの文字列
 * だけを持つ)。`answer-bench.ts`/`time-weighting-bench.ts` を変更してこの内訳を
 * 新たに公開する代わりに、既に文字列として持っている値を読み取るだけにする
 * ——変更を増やさないための選択(この選択自体は
 * `association-default-on-measure.ts` の docstring に書く)。
 *
 * 一致しなければ `null`(推測で埋めない)。
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

// ---------------------------------------------------------------------------
// off/on10 の差・on5/10/20 の表を作るための、数値マップの diff
// ---------------------------------------------------------------------------

export interface NumberDiffCell {
  baseline: number;
  variant: number;
  /** `variant - baseline`。 */
  absoluteDiff: number;
  /** `baseline === 0` なら null(0除算を「0%」と偽らない)。 */
  percentOfBaseline: number | null;
}

/**
 * 2つの「欄名→数値」マップを同じ欄名どうしで比較する。**両方に同じ欄名の集合が
 * 要る**——片方にしか無い欄名は `Error` にする(黙って0で埋めると「元々0件だった」
 * と「比較対象に無い」が区別できなくなる)。
 */
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

/** `NumberDiffCell` を1行の Markdown テーブル行セルへ整形する(表示専用、副作用なし)。 */
export function formatNumberDiffCell(cell: NumberDiffCell): string {
  const sign = cell.absoluteDiff > 0 ? "+" : "";
  const percent =
    cell.percentOfBaseline === null ? "(基準0)" : `${sign}${cell.percentOfBaseline.toFixed(1)}%`;
  return `${cell.baseline} → ${cell.variant} (${sign}${cell.absoluteDiff}, ${percent})`;
}

// ---------------------------------------------------------------------------
// 決定性の確認(同じ条件で2回走らせて一致するか)
// ---------------------------------------------------------------------------

/**
 * オブジェクトを深く走査し、指定した key を持つ欄を再帰的に取り除いた複製を返す。
 * `Date` は ISO 文字列に写す(`JSON.stringify` が既定でそうするのと同じ変換を、
 * 比較の前に明示的に行うだけ)。
 *
 * **何のためか**: 2回の実行結果を比較して「決定的か」を確かめたいが、`tenantId`
 * (実行ごとに新しいトークンを含む)・`measuredAt`/`now`(壁時計)・`tenantId` を
 * 含む `armLabel` のような、**構造上毎回変わることが分かっている欄**まで一致を
 * 要求すると、決定的な実行を「一致しない」と誤って報告してしまう。
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

/**
 * `redactVolatileFields` した上で構造的に一致するかを確かめる。
 * `JSON.stringify` による比較(キー順序に依存する)——`a`/`b` が同じ構築コード
 * (このベンチの同じ抽出関数)を通っていれば、キー順序も揃っているはずである。
 */
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

/** 2回の実行のどちらでも変わりうると分かっている欄名(このベンチの構築上の理由による)。 */
export const KNOWN_VOLATILE_FIELD_NAMES: readonly string[] = [
  "tenantId",
  "armLabel",
  "measuredAt",
  "now",
  "commit",
  "usageReport",
  "drain",
];
