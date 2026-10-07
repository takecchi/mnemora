/**
 * Clock（docs/architecture.md §5.10）。runtime が「現在時刻」を取得する唯一の場所。
 * `ScoringStrategy` / `DecayStrategy` は `now` を引数で受ける純関数で、`Clock` を直接は使わない。
 *
 * **注入した時計が届くもの**（ADR 0355）:
 * - Observation・Memory の `recordedAt`、`decayFloorAt`、reinforce の `lastReinforcedAt`。
 * - `tick` が `claimBatch`/`complete`/`fail` に渡す `now`/`opts.at`。
 * - runtime が書くすべての `memory_events.at`。ただし `archived`（`sweepArchive` 経由）だけは、
 *   呼び出し側が渡す `ArchiveDecayedOptions.now` を使う。
 * - `purgeMemory` の `purgedAt`（`event.at` と同じ値）、`NewRecallRecord.createdAt`。
 * - `MemoryStore.create{Observation,Memory}WithOutbox`・`supersedeWithNewMemories?` の `opts.now`、
 *   `requeueEmbedJobs` の `writeOpts.now`（積む outbox 行の `availableAt`・`createdAt`）。
 *
 * ⟹ 壁時計より過去の時計を注入しても、`tick` は積んだジョブを取れる（`available_at <= now` が同じ時計の中で閉じる）。
 *
 * **壁時計のまま残るもの**:
 * - `updated_at` 列と `memories.created_at`、`recall_usages.used_at`、`vector_embeddings.created_at`、
 *   `labels.registered_at`、`tenant_settings`・`tenant_activity` の `updated_at`。
 * - `purgeExpiredEventsForTenant`（`event-retention-purge.ts`）の `opts.now`（既定 `new Date()`）と、
 *   それが積む `events_purged` の `at`。`RuntimeDeps.clock` を受け取らない独立した部品のため。
 *
 * 上の `opts`・`writeOpts`・`NewRecallRecord.createdAt` はいずれも省略可能で、省略すると実装は壁時計（`new Date()`）を使う。
 */
export interface Clock {
  /** 現在時刻を返す。runtime が「今」を得る唯一の口（テストでは固定の時刻を返す実装を注入する）。 */
  now(): Date;
}
