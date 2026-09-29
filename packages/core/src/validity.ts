import type { Memory } from "./memory.js";

/**
 * 有効期間（`validFrom`/`validUntil`）の外にあるかどうかの分類（Issue #1188、ADR 0164 決定1）。
 *
 * `recall()` の期間のゲート（`recall-runtime.ts` の `survivesValidityGate`）・`consolidate()`・
 * `reflect()` の3箇所が同じ述語を必要とする——**1箇所に述語を置く**規律
 * （`recall-runtime.ts` の `survivesDecayGate`/`survivesValidityGate`/`subjectId` の後置フィルタの
 * doc コメントが引く ADR 0038「実装が2つあると食い違う」の穴を避けるため）を、この3箇所にも適用する。
 *
 * 境界は `recall()` の期間のゲートと同じ——左端 `validFrom` は含む（`<=` ではなく `>` で弾く＝
 * `validFrom === at` は有効側）、右端 `validUntil` は含まない（`validUntil === at` は期限切れ側）。
 * **逆転した区間**（`validFrom > validUntil`。Issue #1042）は、どの `at` でも期間の外にある
 * ——`validUntil` の判定を先に見るので `"expired"` になる。
 *
 * `null` は「期間の内側（または両方 null で無期限）」を表す——「期間の外にある」ことを示す積極的な
 * 分類だけを返し、内側であることの理由（両端 null／片端だけ／両端とも内側）までは分類しない。
 * `index.ts` からは出さない内部の関数である。
 */
export function classifyValidity(
  memory: Pick<Memory, "validFrom" | "validUntil">,
  at: Date,
): { kind: "expired"; validUntil: Date } | { kind: "not_yet_valid"; validFrom: Date } | null {
  if (memory.validUntil != null && memory.validUntil <= at) {
    return { kind: "expired", validUntil: memory.validUntil };
  }
  if (memory.validFrom != null && memory.validFrom > at) {
    return { kind: "not_yet_valid", validFrom: memory.validFrom };
  }
  return null;
}
