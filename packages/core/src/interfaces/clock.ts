/**
 * Clock — Phase 1（docs/architecture.md §5.10）。
 *
 * `ScoringStrategy` / `DecayStrategy` は `now` を引数として受け取る純関数であり、
 * `Clock` を直接は使わない。`Clock` は runtime が「現在時刻」を取得する唯一の場所であり、
 * テストで固定時刻を注入できるようにするための境界。
 *
 * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)）:
 * 注入した時計が届くのは、runtime が自分で時刻を決める所だけである。**Observation・Memory の `recordedAt`、
 * `decayFloorAt`、`tick` が `claimBatch` に渡す `now` は注入した時計に従う。一方、store が書き込みのときに埋める
 * 時刻——監査ログ（`memory_events`）の `at`（runtime が `at` を渡すのは `restoreSupersededBy` だけ）、`purgedAt`、
 * recall の記録の `createdAt`、outbox の `createdAt`・`availableAt`・`completedAt`——は壁時計になる。
 * ⟹ **壁時計より過去の時刻を注入すると、`tick` は積んだジョブを1本も取らない**（`available_at` が壁時計で、
 * claim は `available_at <= now` のジョブだけを取るため。`processed: 0` で、何も名乗らない）。過去の時刻での
 * 取り込み直しやテストでは、extract も embed も走らない。
 * 【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture で同じ（`injected-clock-reach.postgres.test.ts`）。
 *
 * ⚠ **2026-09-28 追記（復帰と掃引の口、同じ Issue #1237）:** reinforce（`lastReinforcedAt`・`decayFloorAt`）は、
 * どの経路でも注入した時計に従う——`observe` の使用報告・`restoreArchived`・`restoreSuperseded` のどれでも、
 * runtime が `clock.now()` を渡す。一方、監査ログの `at` は口によって割れている:
 *
 * | 口 | 監査ログのイベント | `at` の出どころ |
 * |---|---|---|
 * | `sweepArchive` | `archived` | 壁時計（どれを選ぶかの基準は、呼び出し側が渡す `opts.now`。注入した時計ではない） |
 * | `restoreArchived` | `restored` | 壁時計 |
 * | `restoreSuperseded` | `unsuperseded` | 注入した時計（runtime が `at` を渡す唯一の口） |
 *
 * ⟹ 同じ「戻す」操作でも、`restored` と `unsuperseded` は別の時計で打たれる。時計を注入した runtime で、ある
 * Memory の監査ログを `at` で並べると、この2つの口のイベントは別の時計の順に並ぶ。
 * 【実測 2026-09-28】`@mnemora/postgres` と testkit の fixture で同じ（同じテストファイル）。
 */
export interface Clock {
  /** 現在時刻を返す。runtime が「今」を得る唯一の口（テストでは固定の時刻を返す実装を注入する）。 */
  now(): Date;
}
