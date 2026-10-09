import { isHalfLifeHoursInRange, isHalfLifeRecallsInRange } from "@mnemora/core";
import type { NewMemory } from "@mnemora/core";

/**
 * float4（`real`）列に入らない値（`Math.fround` が `Infinity` か 0 になる）を、DB の生の例外でなく、
 * `packages/testkit` の fixture と同じ判定の明示の例外で拒む。
 * 文言は揃えていない: fixture と core の Fake は 0 に丸まるときに `; rounds to 0` を足し、先頭の名前もそれぞれ違う。
 * 揃っているのは、欄の名前から `(got <値>` まで（`<field> does not fit in a Postgres "real" (float4) column (got <値>`）である。
 */
function assertFitsFloat4(label: string, field: string, value: number): void {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded) || rounded === 0) {
    throw new Error(
      `${label}: ${field} does not fit in a Postgres "real" (float4) column (got ${value})`,
    );
  }
}

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

export function assertHalfLifeRecallsFitsFloat4(label: string, recalls: number): void {
  assertFitsFloat4(label, "recalls", recalls);
}
