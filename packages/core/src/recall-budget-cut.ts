import type { TokenCounter } from "./interfaces/token-counter.js";

export interface BudgetUnit {
  members: ReadonlyArray<{ memory: { digest: string } }>;
}

export function unitChars(unit: BudgetUnit): number {
  return unit.members.reduce((sum, m) => sum + m.memory.digest.length, 0);
}

export function unitTokens(unit: BudgetUnit, tokenCounter: TokenCounter): number {
  return unit.members.reduce((sum, m) => sum + tokenCounter.count(m.memory.digest).tokens, 0);
}

function prefixSums(values: readonly number[]): number[] {
  const prefix: number[] = new Array<number>(values.length + 1);
  let sum = 0;
  prefix[0] = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    prefix[i + 1] = sum;
  }
  return prefix;
}

function isMonotoneSafe(values: readonly number[]): boolean {
  for (const v of values) {
    if (!(v >= 0)) return false;
  }
  return true;
}

/** 二分探索は `ok` が k について単調なときだけ正しい。単調と分からないときは hi から下へ線形に探す。 */
function largestOk(hi: number, monotone: boolean, ok: (k: number) => boolean): number {
  if (!monotone) {
    for (let k = hi; k > 0; k -= 1) {
      if (ok(k)) return k;
    }
    return 0;
  }
  let lo = 0; // ok(lo) が真か lo === 0
  let up = hi; // ok(k) は k > up で偽
  while (lo < up) {
    const mid = lo + Math.ceil((up - lo) / 2);
    if (ok(mid)) lo = mid;
    else up = mid - 1;
  }
  return lo;
}

/**
 * 段4（予算による切り詰め）で先頭から残す単位数を返す（ADR 0431）。
 *
 * 二分探索に替えない場面がある: `tokenCounter` は利用者が差し替えられ、負の値・NaN を返すと累積和が
 * 単調でなくなり二分探索が崩れる。その場合は累積和の上を k=n から下へ線形に探す。
 * `fits` の式は `!(sum > max)` の向きを変えない（NaN との比較の結果が変わる）。
 * トークンは文字数の制限を満たす範囲の単位だけ数える（範囲外のために `tokenCounter` を呼ばない）。
 */
export function findBudgetCut(
  units: readonly BudgetUnit[],
  limits: { maxMemoryChars: number | undefined; maxTokens: number | undefined },
  tokenCounter: TokenCounter,
): number {
  const n = units.length;
  const { maxMemoryChars, maxTokens } = limits;

  let charsOk: (k: number) => boolean = () => true;
  let charsMonotone = true;
  if (maxMemoryChars !== undefined) {
    const values = units.map((u) => unitChars(u));
    const prefix = prefixSums(values);
    charsMonotone = isMonotoneSafe(values);
    charsOk = (k) => !(prefix[k]! > maxMemoryChars);
  }
  const charsCeiling = largestOk(n, charsMonotone, charsOk);
  if (charsCeiling === 0 || maxTokens === undefined) return charsCeiling;

  const tokenValues = units.slice(0, charsCeiling).map((u) => unitTokens(u, tokenCounter));
  const tokenPrefix = prefixSums(tokenValues);
  return largestOk(
    charsCeiling,
    charsMonotone && isMonotoneSafe(tokenValues),
    (k) => charsOk(k) && !(tokenPrefix[k]! > maxTokens),
  );
}

/** 壊れた `tokens` の値の種類。**値そのものと、数えた文字列は message に入れない**（ADR 0497）。 */
function describeBrokenTokens(tokens: unknown): string {
  if (typeof tokens !== "number")
    return `a non-number (${tokens === null ? "null" : typeof tokens})`;
  if (Number.isNaN(tokens)) return "NaN";
  if (tokens === Infinity) return "Infinity";
  if (tokens === -Infinity) return "-Infinity";
  return "a negative number";
}

/**
 * `recall()` が1回の呼び出しの頭で `deps.tokenCounter` を包む（ADR 0497）。`tokens` が
 * 「有限で 0 以上の number」でなければ `RangeError` を投げる（最初の壊れた値で止まる）。
 *
 * - `counter` 欄は検査しない（ADR 0483・0487）。
 * - `count()` が投げた例外は包まず素通しする。
 * - 小数は通す（有限で 0 以上なら足し算は成り立つ。ADR 0483）。
 * - ライブラリ内部の関数で、`index.ts` からは出さない。
 */
export function checkedTokenCounter(inner: TokenCounter): TokenCounter {
  return {
    count(text: string) {
      const result = inner.count(text);
      const tokens: unknown = (result as { tokens?: unknown } | null | undefined)?.tokens;
      if (typeof tokens !== "number" || !(tokens >= 0 && tokens < Infinity)) {
        throw new RangeError(
          `recall: tokenCounter.count() must return { tokens } as a finite number >= 0, got ${describeBrokenTokens(tokens)}`,
        );
      }
      return result;
    },
  };
}
