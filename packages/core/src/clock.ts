import type { Clock } from "./interfaces/clock.js";

/** 実時間を返す既定実装。 */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

/** テストで固定時刻を注入するための実装。 */
export function fixedClock(at: Date): Clock {
  return {
    now(): Date {
      return at;
    },
  };
}
