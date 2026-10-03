/**
 * Clock — Phase 1（docs/architecture.md §5.10）。
 *
 * `ScoringStrategy` / `DecayStrategy` は `now` を引数として受け取る純関数であり、
 * `Clock` を直接は使わない。`Clock` は runtime が「現在時刻」を取得する唯一の場所であり、
 * テストで固定時刻を注入できるようにするための境界。
 *
 * ⭐ **2026-09-29 追記（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」、
 * ADR 0355）: 注入した時計は、runtime が書き込む時刻のほぼ全部に届く。** 2026-09-27・09-28 の
 * 実測（このファイルの旧い版、履歴は git blame）は「監査ログの `at`・`purgedAt`・recall の
 * `createdAt`・outbox の3欄は壁時計になる」という**直っていない振る舞い**を記録していた——
 * 本追記はその後の状態を書く。
 *
 * **注入した時計が届くもの**（`Runtime` の書き込み系メソッドすべてに共通）:
 * - Observation・Memory の `recordedAt`、`decayFloorAt`、reinforce の `lastReinforcedAt`。
 * - `tick` が `claimBatch`/`complete`/`fail` に渡す `now`/`opts.at`。
 * - runtime が書くすべての `memory_events.at`（`created`・`restored`・`forgotten`・`purged`・
 *   `archived`・`superseded`・`unsuperseded`・`updated`（contested 系含む）のどれでも、runtime は
 *   `clock.now()` を渡す。`archived`（`sweepArchive` 経由）だけは例外で、呼び出し側が明示的に渡す
 *   `ArchiveDecayedOptions.now` を使う——これも「注入した時計に従う」側であり、
 *   `sweepArchive(ctx, { now: clock.now(), ... })` と呼べば同じ時計になる）。
 * - `purgeMemory` の `purgedAt`（`event.at` と同じ値。runtime は両方に同じ `clock.now()` を渡す）。
 * - `MemoryStore.createRecall`/`NewRecallRecord.createdAt`（recall の記録の時刻）。
 * - `MemoryStore.create{Observation,Memory}WithOutbox`・`supersedeWithNewMemories?` の `opts.now`、
 *   `requeueEmbedJobs` の `writeOpts.now`（積む outbox 行の `availableAt`・`createdAt`。
 *   `observe`・`reextract`・`consolidate`・`reflect`・`reembed` のどれで積んだジョブも同じ）。
 *
 * ⟹ **壁時計より過去の時計を注入しても、`tick` は積んだジョブを取れる**——`available_at` が
 * 注入した時計に従うため、`claimBatch` の `available_at <= now` が同じ時計の中で閉じる。
 * 【実測 2026-09-29】`@mnemora/postgres` と testkit の fixture で同じ
 * （`injected-clock-reach.postgres.test.ts`）。
 *
 * **今も壁時計のまま残るもの**（本 Issue の範囲外。`Runtime`/`Clock` の管轄ではない列・関数）:
 * - `updated_at` 列（`memories`/`outbox` 等）と `memories.created_at`。
 * - `recall_usages.used_at`（公開の口からは読まれない）。
 * - `vector_embeddings.created_at`。
 * - `labels.registered_at`（`MemoryStore.registerLabel?` が書く。`TenantSettingsStore` の列ではない）。
 * - `tenant_settings`・`tenant_activity` の `updated_at`（`TenantSettingsStore` の書き込みが SQL の `now()` で書く）。
 * - `packages/core/src/event-retention-purge.ts` の `purgeExpiredEventsForTenant` の
 *   `opts.now`（既定 `new Date()`）——`Runtime` のメソッドではなく
 *   `{ memoryStore, tenantSettingsStore }` だけを受け取る独立した部品であり、
 *   `RuntimeDeps.clock` を受け取らない（Issue #1237 コメント参照）。この部品が積む
 *   `events_purged` イベントの `at` も `clock` の時刻ではない——Postgres も testkit の
 *   fixture も、store の中の JS の壁時計（`new Date()`）で積む（Postgres は SQL の `now()`
 *   だったが、ADR 0427 でミリ秒に揃えるため JS 側の時刻へ替えた）。
 *
 * `MemoryStore.create{Observation,Memory}WithOutbox`・`supersedeWithNewMemories?` の `opts`・
 * `requeueEmbedJobs` の `writeOpts`・`OutboxStore.complete`/`fail` の `opts`・
 * `NewRecallRecord.createdAt` はいずれも省略可能——省略すると実装は壁時計
 * （`new Date()`）を使う（今日までと同じ挙動）。**型としては追加のみ**（ADR 0355「決めたこと」）。
 */
export interface Clock {
  /** 現在時刻を返す。runtime が「今」を得る唯一の口（テストでは固定の時刻を返す実装を注入する）。 */
  now(): Date;
}
