/**
 * TokenCounter — Phase 1（docs/architecture.md §5.9・docs/recall.md §6）。
 *
 * 契約:
 * - 既定実装は文字数ベースの推定（`counter: 'heuristic'`）。
 * - 推定値を実測値の顔で返してはならない——`counter` フィールドは必須。
 */
export interface TokenCounter {
  /** `text` のトークン数を数える。推定なら `counter: "heuristic"`、実測なら `"exact"` を必ず返す。 */
  count(text: string): { tokens: number; counter: "heuristic" | "exact" };
}
