/**
 * `time-weighting-case-set.*.ts` が使う、時刻を組み立てるための小さな純関数。
 *
 * ⛔ **確率的な値・`new Date()`（実行時の現在時刻）を混ぜない。** ケースはすべて
 * 固定の基準時刻（`recallAt`）からの相対オフセットで組み立てる——実行するたびに
 * 結果が変わるのを避けるため（`answer-case-set.*.ts` が会話の中身を固定文字列で
 * 書いているのと同じ理由）。
 */

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

/** `base` から `hours` 時間前。 */
export function hoursBefore(base: Date, hours: number): Date {
  return new Date(base.getTime() - hours * MS_PER_HOUR);
}

/** `base` から `days` 日前。 */
export function daysBefore(base: Date, days: number): Date {
  return new Date(base.getTime() - days * MS_PER_DAY);
}
