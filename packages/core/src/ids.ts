/** Memory の識別子の型エイリアス。名前を分けることで、interface のシグネチャが何の識別子を渡すべきかを伝える。 */
export type MemoryId = string;
/** Observation の識別子（不透明な文字列。`@mnemora/postgres` では uuid）。 */
export type ObservationId = string;
/** `memory_events` の1行（監査ログのイベント）の識別子（不透明な文字列）。 */
export type EventId = string;
/** `recall()` の1回の記録（`recalls` の行）の識別子。`observe({ kind: "memory_usage" })` の使用報告と `getRecall` で使う。 */
export type RecallId = string;
