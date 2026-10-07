/** `new Date()` や確率的な値を混ぜない: ケースは固定の基準時刻からの相対オフセットで組み立て、実行のたびに結果が変わるのを避ける。 */

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

export function hoursBefore(base: Date, hours: number): Date {
  return new Date(base.getTime() - hours * MS_PER_HOUR);
}

export function daysBefore(base: Date, days: number): Date {
  return new Date(base.getTime() - days * MS_PER_DAY);
}
