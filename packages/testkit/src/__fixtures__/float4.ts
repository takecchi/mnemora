/**
 * Postgres の `real`（float4）の列に書いた number が、読み戻されるときの値を返す。
 *
 * 値は float4 に丸められて保存される（`Math.fround`）。読み戻すときは、Postgres が float4 を「float4 として一意に
 * 決まる最短の10進表記」で文字列にし、ドライバがそれを float64 として読む。だから読み戻す値は
 * `Math.fround(x)` そのものではない（`Math.fround(720.1)` は `720.0999755859375` だが、読み戻す値は `720.1`）。
 * ここでは最短の表記（有効桁数 1〜9 のうち、float4 に丸め直すと元の float4 に戻る最小の桁数）を探して返す。
 *
 * 呼び出す前に、値が float4 の範囲に収まる（`Math.fround` が有限で、0 でない値が 0 に丸まらない）ことを
 * 各 fixture の検査で確かめてあること。`0` はそのまま返す。
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
