/**
 * TokenCounter — Phase 1（docs/architecture.md §5.9・docs/recall.md §6）。
 *
 * 契約:
 * - 既定実装は文字数ベースの推定（`counter: 'heuristic'`）。
 * - 推定値を実測値の顔で返してはならない——`counter` フィールドは必須。
 * - `tokens` は 0 以上の整数、`counter` は `"heuristic" | "exact"` のどちらか。
 *
 * ⚠ **この契約は実行時には検査されない**（ADR 0483。今の振る舞いを書いたもの）。
 * `recall()` は差し替えた実装の戻り値を、次のとおりそのまま使う:
 * - `tokens` が `NaN` または負の数: 段4（`maxMemoryTokens`・`promptBudgetTokens`）の切り詰めを**黙って外す**
 *   （累積和が `NaN` になる・小さくなるので、どの先頭 k 件も予算に収まる）。例外にはならず、`omitted` にも
 *   `budget_dropped` は出ない。
 * - `tokens` が `Infinity`: 1件目から収まらず、全件を落とす（`budget_dropped`）。
 * - `tokens` が非整数: そのまま足す。
 * - `counter` の欄が無い・範囲外の文字列: そのまま `RecallResult.usage.counter` に出る。
 * - 例外を投げる: `recall()` の失敗になる（予算が無くても `usage` の計測で呼ばれる）。
 * 壊れた値が `usage` に出たことは、`RecallResult.outputValidation`（`RuntimeDeps.outputValidation`、
 * 既定 `"report"`、ADR 0098）が知らせる。`"off"` では知らされない。
 *
 * ⚠ `RecallResult.usage.counter` の印は、返した digest を連結し目次帯の JSON を足した文字列を1回数えた値の `counter` である。
 * 段4の予算の判定は digest ごとに `count()` を呼ぶので、テキストによって `counter` を変える実装では、
 * `usage.counter` の印と予算の判定に使った印が食い違いうる（ADR 0487。今の振る舞いを書いたもの）。
 */
export interface TokenCounter {
  /** `text` のトークン数を数える。推定なら `counter: "heuristic"`、実測なら `"exact"` を必ず返す。 */
  count(text: string): { tokens: number; counter: "heuristic" | "exact" };
}
