/**
 * TokenCounter（docs/architecture.md §5.9・docs/recall.md §6）。
 *
 * 契約:
 * - 既定実装は文字数ベースの推定（`counter: 'heuristic'`）。
 * - 推定値を実測値の顔で返してはならない——`counter` フィールドは必須。
 * - `tokens` は 0 以上の整数、`counter` は `"heuristic" | "exact"` のどちらか。
 *
 * 🔴 **`tokens` の契約は `recall()` が実行時に検査する**（ADR 0497）。`count()` の戻り値の `tokens` が
 * 有限で 0 以上の number でなければ（NaN・負の数・Infinity・number でない値・戻り値の欠落）、`recall()` は
 * `RangeError` で断る。message は値の種類だけを載せ、入力テキストは載せない。`RuntimeDeps.outputValidation`
 * （ADR 0098）が `"off"` でも、予算が無くても断る。最初の壊れた値で止まる。
 * - `tokens` が非整数（`0.5` など）: 通る。そのまま足す。
 * - `count()` が例外を投げる: 包まずそのまま `recall()` の失敗になる。
 * - `counter` の欄が無い・範囲外の文字列: **断らない**。そのまま `RecallResult.usage.counter` に出て、
 *   `RecallResult.outputValidation`（既定 `"report"`）が知らせる。`"off"` では知らされない。
 *
 * ⚠ `RecallResult.usage.counter` の印は、返した digest を連結し目次帯の JSON を足した文字列を1回数えた値の `counter` である。
 * 予算の判定は digest ごとに `count()` を呼ぶので、テキストによって `counter` を変える実装では、
 * `usage.counter` の印と予算の判定に使った印が食い違いうる（ADR 0487）。
 */
export interface TokenCounter {
  /** `text` のトークン数を数える。推定なら `counter: "heuristic"`、実測なら `"exact"` を必ず返す。 */
  count(text: string): { tokens: number; counter: "heuristic" | "exact" };
}
