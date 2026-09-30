import type { TokenCounter } from "./interfaces/token-counter.js";

/**
 * 段4（予算による切り詰め）の `cut` — 先頭から何単位を残すか — を求める（ADR 0431）。
 *
 * 旧実装は `while (cut > 0 && !fits(allUnits.slice(0, cut))) cut -= 1` で、`fits` が毎回 prefix 全体を
 * 足し直していたため O(n²) だった（n=4000 で 4.2 秒）。ここは **累積和を1回作り、二分探索で同じ `cut` を
 * 求める**。**結果は旧実装と1ビットも変えない**（旧実装を写した参照実装との一致を
 * `recall-budget-cut.test.ts` が縛る）。
 *
 * 同じ結果になる理由:
 * - 旧実装が返すのは「`1 <= k <= n` で `fits(prefix(k))` を満たす最大の k、無ければ 0」。
 * - `fits` の式は変えない: 文字数は各単位の digest 長の合計が `maxMemoryChars` を **超えない**こと
 *   （`!(chars > max)`。NaN との比較も旧式と同じ向きで扱う）、トークン数は **単位ごと（メンバーごと）の
 *   `tokenCounter.count(digest).tokens` を足し、単位の合計をさらに先頭から足した値**が `maxTokens` を
 *   超えないこと。足す順（メンバー → 単位、先頭から）も旧式と同じなので、浮動小数点の丸めも同じ。
 * - 二分探索が正しいのは、`fits` が k について単調（k が大きいほど厳しくなる）ときだけである。
 *   単位ごとの値がすべて 0 以上（NaN でない）なら、累積和は単調非減少になり単調になる。文字数は
 *   `digest.length` で必ずそうなる。**`tokenCounter` は利用者が差し替えられる**ので、負の値・NaN を返す
 *   と崩れる。その場合は二分探索を使わず、累積和の上を旧実装と同じ向き（k=n から下へ）に線形に探す
 *   （O(n) のまま、結果は同じ）。
 * - トークンを数えるのは、文字数の制限を満たす最大の k（旧実装が最初に `fits` のトークン側へ進む prefix）
 *   の範囲の単位だけ。旧実装が数えなかった単位のために `tokenCounter` を呼ばない。
 *   （呼ぶ回数は変わる: 旧実装は同じ digest を何度も数えていた。数える digest の集合は同じか、その部分集合。）
 */

/** 予算の検査に要る、単位の最小の形。 */
export interface BudgetUnit {
  members: ReadonlyArray<{ memory: { digest: string } }>;
}

export function unitChars(unit: BudgetUnit): number {
  return unit.members.reduce((sum, m) => sum + m.memory.digest.length, 0);
}

export function unitTokens(unit: BudgetUnit, tokenCounter: TokenCounter): number {
  return unit.members.reduce((sum, m) => sum + tokenCounter.count(m.memory.digest).tokens, 0);
}

/** 先頭からの累積和。`prefix[k]` は先頭 k 単位の合計（`prefix[0] === 0`）。 */
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

/** すべて 0 以上（NaN を含まない）なら、累積和は単調非減少で、二分探索してよい。 */
function isMonotoneSafe(values: readonly number[]): boolean {
  for (const v of values) {
    if (!(v >= 0)) return false;
  }
  return true;
}

/**
 * `ok(k)`（k = 1..hi）を満たす最大の k を返す。無ければ 0。
 * `monotone` が true のときは `ok` が「ある k までは真、それより先は偽」と分かっているので二分探索、
 * false のときは旧実装と同じく hi から下へ線形に探す。
 */
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

export function findBudgetCut(
  units: readonly BudgetUnit[],
  limits: { maxMemoryChars: number | undefined; maxTokens: number | undefined },
  tokenCounter: TokenCounter,
): number {
  const n = units.length;
  const { maxMemoryChars, maxTokens } = limits;

  // 文字数。制限が無ければ、どの k でも通る。
  let charsOk: (k: number) => boolean = () => true;
  let charsMonotone = true;
  if (maxMemoryChars !== undefined) {
    const values = units.map((u) => unitChars(u));
    const prefix = prefixSums(values);
    charsMonotone = isMonotoneSafe(values);
    charsOk = (k) => !(prefix[k]! > maxMemoryChars);
  }
  // 文字数の制限を満たす最大の k。旧実装が、トークン側の検査へ初めて進む prefix の大きさ。
  const charsCeiling = largestOk(n, charsMonotone, charsOk);
  if (charsCeiling === 0 || maxTokens === undefined) return charsCeiling;

  // トークン数。文字数の制限を満たす範囲（先頭 charsCeiling 単位）だけ数える。
  const tokenValues = units.slice(0, charsCeiling).map((u) => unitTokens(u, tokenCounter));
  const tokenPrefix = prefixSums(tokenValues);
  return largestOk(
    charsCeiling,
    charsMonotone && isMonotoneSafe(tokenValues),
    (k) => charsOk(k) && !(tokenPrefix[k]! > maxTokens),
  );
}
