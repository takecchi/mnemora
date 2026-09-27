/**
 * Clock — Phase 1（docs/architecture.md §5.10）。
 *
 * `ScoringStrategy` / `DecayStrategy` は `now` を引数として受け取る純関数であり、
 * `Clock` を直接は使わない。`Clock` は runtime が「現在時刻」を取得する唯一の場所であり、
 * テストで固定時刻を注入できるようにするための境界。
 */
export interface Clock {
  /** 現在時刻を返す。runtime が「今」を得る唯一の口（テストでは固定の時刻を返す実装を注入する）。 */
  now(): Date;
}
