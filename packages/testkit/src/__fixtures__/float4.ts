/**
 * Postgres の `real`（float4）列に書いた number が、読み戻されるときの値を返す。
 * 読み戻す値は `Math.fround(x)` そのものではなく、float4 として一意に決まる最短の10進表記を float64 として読んだもの
 * （`Math.fround(720.1)` は `720.0999755859375` だが、読み戻す値は `720.1`）。
 * 呼ぶ前に、値が float4 の範囲に収まることを各 fixture の検査で確かめておくこと。
 */
export function toFloat4Readback(value: number): number {
  const rounded = Math.fround(value);
  if (rounded === 0 || !Number.isFinite(rounded)) {
    return rounded;
  }
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(rounded.toPrecision(digits));
    if (Math.fround(candidate) === rounded) {
      return candidate;
    }
  }
  return rounded;
}
