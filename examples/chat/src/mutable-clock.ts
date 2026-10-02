import type { Clock } from "@mnemora/core";

/**
 * `now()` が返す時刻を差し替えられる `Clock` 実装(`decay` を `freshness` から分離して測るために足す)。
 *
 * **`Clock` 型は `@mnemora/core` から公開されている**——`packages/core/src/index.ts` が
 * `export * from "./interfaces/clock.js"` しており、`interfaces/clock.ts` の
 * `export interface Clock { now(): Date }` がそのまま外へ出ている(`systemClock`/`fixedClock`
 * も同様に公開)。⟹ 構造的に満たす別形を用意する必要は無く、`@mnemora/core` の `Clock` を
 * そのまま実装する。
 *
 * **これで何ができるか**: `packages/core/src/runtime.ts` は `Observation.recordedAt` と
 * `Memory.recordedAt`/`decayFloorAt` の計算に `clock.now()` を使う(`RuntimeDeps.clock`、
 * 既定は `systemClock`)。これを注入すれば、`observe()` の `occurredAt` に触れずに
 * `recordedAt` だけを過去へ振れる——`decay` の起点は `lastReinforcedAt ?? recordedAt` で
 * あり `occurredAt` を読まない(`packages/core/src/strategies/scoring.ts` の docstring)ため、
 * これで `freshness` を動かさずに `decay` だけを動かせる。
 *
 * `packages/postgres` の `outbox.available_at` も、この `Clock` に従う——runtime が
 * `clock.now()` 由来の `now` を store に渡し、store は `opts?.now ?? new Date()` を入れる
 * (ADR 0355、記述の訂正は ADR 0559。SQL の `now()` は使わない)。ADR 0355 より前は
 * SQL の `now()` で入っていたため、この `Clock` を過去に置くと embed ジョブが claim
 * できなかった。呼び出し側に残る「tick の前に実時刻へ戻す」処理はその名残である。
 */
export interface MutableClock extends Clock {
  set(at: Date): void;
}

/** 既定の初期値は実時刻(`new Date()`)。 */
export function createMutableClock(initial: Date = new Date()): MutableClock {
  let current = initial;
  return {
    now(): Date {
      return current;
    },
    set(at: Date): void {
      current = at;
    },
  };
}
