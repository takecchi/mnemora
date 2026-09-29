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

/**
 * 有効期間（`validFrom`/`validUntil`）の**積**（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)
 * 残り、[ADR 0368](../../../docs/decisions/0368-consolidate-reflect-validity-intersection.md)）:
 * `validFrom` は `eligible` の `validFrom` の**最大値**、`validUntil` は `eligible` の
 * `validUntil` の**最小値**。`null` は「その端に制限が無い」——両方 `null` の記憶は
 * どちらの端も動かさない。**全件が両方 `null` なら、結果も両方 `null`**（今までの
 * 振る舞いを変えない）。
 *
 * `strategies/consolidate.ts` の `intersectAttributes` と同じ形の積であり、`buildConsolidatedMemory`
 * （`strategies/consolidate.ts`）と `buildReflectedMemory`（`strategies/reflect.ts`）が共有する
 * 純関数。`classifyValidity`（上）と同じく **`index.ts` からは出さない内部の関数**である——
 * `strategies/consolidate.ts` は `index.ts` が `export *` で公開するので、そこには置かない
 * （公開 API は一度出すと semver で縛られ、利用者がこの関数を使う理由も無い）。
 *
 * **なぜ積か（和・最新ではなく）**: 統合・内省した本文は、材料**すべて**の主張を含む
 * ——だから統合先・内省の記憶が「まだ真」と言えるのは、材料**全員**がまだ真である間
 * だけである。どれか1つの元の記憶の期限が切れた時点で、統合先・内省の記憶の本文の
 * 一部（その元の記憶に由来する主張）はもう真ではなくなる。和・最新を採らなかった
 * 理由は ADR 0368「採らなかった案」。
 *
 * **空の積（`validFrom >= validUntil` になる組み合わせ）は起こらない。** `eligible` は
 * 呼び出し側（`runtime.ts` の consolidate 手順2・reflect 手順2）が
 * `classifyValidity(m, validAt)`（`validity.ts`）を通して選んだものだけであり、この
 * 述語を通る記憶は `max(validFrom) <= validAt < min(validUntil)` を満たす（逆転した
 * 区間・期限切れ・未到来は弾かれる）。⟹ この関数が返す区間の `validFrom` と
 * `validUntil` が両方非 `null` なら、必ず `validFrom < validUntil` になる。
 *
 * ⚠ **窓（受け入れる。ADR 0368 決定2）**: 材料を選ぶ時刻（`classifyValidity` に渡す
 * `validAt`、`runtime.ts` の `clock.now()`）と、この関数の返り値を使って統合先・内省の
 * 記憶を作る時刻（`recordedAt` にする `now`、同じく `clock.now()`）は**別の呼び出し**
 * で、間に LLM 呼び出しが挟まる。その間に `min(validUntil)` を過ぎると、新しい記憶は
 * **作った時点で既に期限切れの `active` な記憶**として書かれる——recall には出ない。
 * これは正しい状態として受け入れる（時計を固定した既存テストでは再現しない窓）。
 *
 * **代償（受け入れる。ADR 0368 決定3）**: 期限の無い記憶 F と、将来の期限を持つ記憶 E
 * を consolidate すると、統合先は E の期限を引き継ぎ、F は（他の統合元と同じく）
 * superseded になる——期限後は F 由来の内容も recall に出なくなる（F 自身の行は
 * superseded として残り、消えはしない）。「期限切れの主張が、期限の無い記憶として
 * 永久に recall へ戻り続ける」という Issue #1188 の元の害より小さいと判断した
 * （reflect は材料を superseded にしないので、この代償は無い）。
 *
 * `eligible` が空なら `{ validFrom: null, validUntil: null }`（`intersectAttributes` と
 * 同じく、呼び出し側は必ず1件以上を渡す契約だが、空配列に対しても安全に応答する）。
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
