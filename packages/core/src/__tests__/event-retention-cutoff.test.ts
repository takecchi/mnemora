import { describe, expect, it } from "vitest";
import { computeEventRetentionCutoff } from "../event-retention-purge.js";

/**
 * `computeEventRetentionCutoff(now, days)` は、`now` から `days` 日ぶん遡った時刻を返す。
 * 日数が大きすぎて `Date` で表せる範囲（±8.64e15 ms）の外に出るときだけ、表せる最も古い時刻へ寄せる
 * （Invalid Date にしない。それより古い行は無いので、結果は0件の削除になる。ADR 0354）。
 *
 * 既存の歯は `days` が 7 などの小さい値と、寄せが効く極大の値だけを使う。ここは、
 * **寄せが効かない大きい日数（200万日 = 約5476年）でも、cutoff が `now` − 日数のまま**であることと、
 * 寄せが効く日数で `Date` の下限になることを縛る。寄せる下限を `now` に近い時刻へ上げる実装は、
 * 200万日の cutoff を「`now` − 日数」より新しい時刻にしてしまい、それより新しい行まで消す。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const DAY_MS = 86_400_000;
const EARLIEST_DATE_MS = -8.64e15;

describe("computeEventRetentionCutoff", () => {
  it.each([1, 7, 365, 1_000_000, 2_000_000, 24_000_000])(
    "%i 日: now から日数ぶん遡った時刻をそのまま返す（Date の範囲に収まる日数は寄せない）",
    (days) => {
      const cutoff = computeEventRetentionCutoff(NOW, days);
      expect(cutoff.getTime()).toBe(NOW.getTime() - days * DAY_MS);
    },
  );

  it.each([2 ** 31 - 1, 100_000_000_000])(
    "%i 日: Date で表せる最も古い時刻へ寄せる（Invalid Date にならない）",
    (days) => {
      const cutoff = computeEventRetentionCutoff(NOW, days);
      expect(Number.isNaN(cutoff.getTime())).toBe(false);
      expect(cutoff.getTime()).toBe(EARLIEST_DATE_MS);
    },
  );
});
