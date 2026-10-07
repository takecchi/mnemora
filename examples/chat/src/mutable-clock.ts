import type { Clock } from "@mnemora/core";

/**
 * `now()` が返す時刻を差し替えられる `Clock`。`recordedAt` だけを過去へ振れる（`decay` の起点は `occurredAt` を読まないので、
 * `freshness` を動かさず `decay` だけを動かせる）。`@mnemora/core` が公開する `Clock` をそのまま実装する。
 */
export interface MutableClock extends Clock {
  set(at: Date): void;
}

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
