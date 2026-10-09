import { isHalfLifeHoursInRange, isHalfLifeRecallsInRange } from "@mnemora/core";
import type { NewMemory } from "@mnemora/core";

/**
 * float4（`real`）列に入らない値（`Math.fround` が `Infinity` か 0 になる）を、DB の生の例外でなく明示の例外で拒む。
 * 見る欄は、MemoryStore の `halfLifeHours`・`halfLifeRecalls` と、TenantSettingsStore の `recalls` である。
 * 判定（`Infinity` か 0 に丸まるか）は、`packages/testkit` の `InMemoryMemoryStore`（`halfLifeHours`・`halfLifeRecalls`）と
 * `InMemoryTenantSettingsStore`（`setDefaultHalfLifeRecalls` の `recalls`）と同じである。
 * 文言は揃えていない: `InMemoryMemoryStore` は3欄（`halfLifeHours`・`strength`・`halfLifeRecalls`）で、0 に丸まるときに
 * `; rounds to 0` を足す。core の `FakeMemoryStore` が足すのは `halfLifeHours`・`strength` の2欄だけで、
 * `InMemoryTenantSettingsStore` は足さない。先頭の名前もそれぞれ違う。
 * 揃っているのは、欄の名前から `(got <値>` まで（`<field> does not fit in a Postgres "real" (float4) column (got <値>`）である。
 * `InMemoryMemoryStore` が見る `strength` は、ここでは見ない。
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
