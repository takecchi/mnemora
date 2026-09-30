import { isHalfLifeHoursInRange, isHalfLifeRecallsInRange } from "@mnemora/core";
import type { NewMemory } from "@mnemora/core";

/**
 * `half_life_hours`・`half_life_recalls`・`tenant_settings.default_half_life_recalls` は Postgres の
 * `real`（float4）列で、`Math.fround(x)` が `Infinity` か 0 になる値は入らない（DB は
 * `"…" is out of range for type real` の生の例外で拒む）。値域が `(0, ∞)` と doc にある以上、
 * 利用者に見せる失敗は DB 由来の生の例外でなく、`packages/testkit` の fixture と同じ判定・
 * 同じ文言の明示の例外にする（判定は fixture の `Math.fround` と同じ）。
 */
function assertFitsFloat4(label: string, field: string, value: number): void {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded) || rounded === 0) {
    throw new Error(
      `${label}: ${field} does not fit in a Postgres "real" (float4) column (got ${value})`,
    );
  }
}

/** `NewMemory` の `halfLifeHours`・`halfLifeRecalls` を、DB へ渡す前に検査する。 */
export function assertNewMemoryHalfLivesFitFloat4(label: string, input: NewMemory): void {
  if (!isHalfLifeHoursInRange(input.halfLifeHours)) {
    throw new Error(`${label}: halfLifeHours out of range (0, ∞): ${input.halfLifeHours}`);
  }
  assertFitsFloat4(label, "halfLifeHours", input.halfLifeHours);
  if (input.halfLifeRecalls != null) {
    if (!isHalfLifeRecallsInRange(input.halfLifeRecalls)) {
      throw new Error(`${label}: halfLifeRecalls out of range (0, ∞): ${input.halfLifeRecalls}`);
    }
    assertFitsFloat4(label, "halfLifeRecalls", input.halfLifeRecalls);
  }
}

/** `setDefaultHalfLifeRecalls` の値が float4 に収まることを検査する。 */
export function assertHalfLifeRecallsFitsFloat4(label: string, recalls: number): void {
  assertFitsFloat4(label, "recalls", recalls);
}
