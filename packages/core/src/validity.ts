import type { Memory } from "./memory.js";

/**
 * 有効期間（`validFrom`/`validUntil`）の外にあるかどうかの分類（ADR 0164）。
 *
 * `recall()` の期間のゲート・`consolidate()`・`reflect()` の3箇所が同じ述語を必要とするため、
 * 述語は1箇所に置く。境界は `validFrom` を含み（`validFrom === at` は有効側）、`validUntil` を
 * 含まない（`validUntil === at` は期限切れ側）。逆転した区間（`validFrom > validUntil`）は
 * どの `at` でも期間の外にあり、`validUntil` の判定を先に見るので `"expired"` になる。
 *
 * `null` は期間の内側（または無期限）で、その理由までは分類しない。
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

/**
 * 有効期間の**積**（[ADR 0368](../../../docs/decisions/0368-consolidate-reflect-validity-intersection.md)）:
 * `validFrom` は `eligible` の最大値、`validUntil` は最小値。`null` は「その端に制限が無い」。
 * 全件が両方 `null` なら、結果も両方 `null`。`eligible` が空でも `{ validFrom: null, validUntil: null }` を返す。
 *
 * `buildConsolidatedMemory` と `buildReflectedMemory` が共有する純関数で、`classifyValidity` と同じく
 * **`index.ts` からは出さない**。`strategies/consolidate.ts` は `export *` で公開されるので、そこには
 * 置かない（公開 API は一度出すと semver で縛られる）。
 *
 * 和・最新ではなく積にするのは、統合・内省した本文は材料すべての主張を含み、どれか1つの期限が
 * 切れた時点で本文の一部がもう真ではなくなるため（ADR 0368「採らなかった案」）。
 *
 * 空の積は起こらない。`eligible` は呼び出し側が `classifyValidity` を通して選んだものだけなので、
 * 両方非 `null` なら必ず `validFrom < validUntil` になる。
 *
 * 窓（ADR 0368 決定2）: 材料を選ぶ時刻と統合先・内省の記憶を作る時刻は別の呼び出しで、間に LLM
 * 呼び出しが挟まる。その間に `min(validUntil)` を過ぎると、作った時点で既に期限切れの `active` な
 * 記憶が書かれる（recall には出ない）。受け入れている。
 *
 * 代償（ADR 0368 決定3）: 期限の無い記憶 F と将来の期限を持つ記憶 E を consolidate すると、統合先は
 * E の期限を引き継ぎ、F は superseded になる。期限後は F 由来の内容も recall に出なくなる
 * （reflect は材料を superseded にしないので、この代償は無い）。
 */
export function intersectValidity(
  eligible: ReadonlyArray<Pick<Memory, "validFrom" | "validUntil">>,
): { validFrom: Date | null; validUntil: Date | null } {
  let validFrom: Date | null = null;
  let validUntil: Date | null = null;
  for (const m of eligible) {
    const from = m.validFrom ?? null;
    if (from !== null && (validFrom === null || from > validFrom)) {
      validFrom = from;
    }
    const until = m.validUntil ?? null;
    if (until !== null && (validUntil === null || until < validUntil)) {
      validUntil = until;
    }
  }
  return { validFrom, validUntil };
}
