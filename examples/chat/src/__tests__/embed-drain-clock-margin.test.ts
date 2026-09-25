import { describe, expect, it } from "vitest";
import { clockPastRecentDbWrites } from "../embed-drain.js";

/**
 * `clockPastRecentDbWrites`（`embed-drain.ts`、Issue #719）の境界条件の検査。
 * **DB 不要・鍵不要**——純関数のみを対象にする。時刻の読み取り自体はモックしない
 * （`nowMs` を直接渡す）——`Date`/`Date.now` をモックすると `new Date()` の内部実装に
 * 依存してしまうため（`vi.useFakeTimers` は `Date.now()` を差し替えても no-arg の
 * `new Date()` まで差し替える保証が実装依存になりうる）。この関数自体は `nowMs` を
 * 受け取る純関数なので、モック無しで境界を検査できる。
 *
 * `time-weighting-recorded-replay.postgres.test.ts` が CI で赤くなった実際の原因
 * （`seedTimeWeightingMemories` が `available_at` と同じ ms 内で `clock` を進めてしまい
 * claim が0件になる）の**数学的な土台**をここで固定する。DB を使った実際の claim の
 * 挙動（同じ現象を `claimBatch` で決定的に再現する）は
 * `__tests__/time-weighting-seed-drain-race.postgres.test.ts` 側で検査する。
 */
describe("examples/chat: clockPastRecentDbWrites（Issue #719、DB不要・決定的）", () => {
  it("available_at の us精度の値を floor(ms) した同じ瞬間からでも、必ずその値を追い越す", () => {
    // 実際の DB `now()` を模した us 精度の epoch（.456 us の端数あり——ちょうど ms の
    // 境界に乗ることはほぼ無い、という実測を反映した値）。
    const availableAtUs = 1_737_953_696_123_456;
    const flooredMs = Math.floor(availableAtUs / 1000); // JS Date が持てる最小の値

    const fixed = clockPastRecentDbWrites(flooredMs);

    // us精度で比較する(Dateのgetime()はms精度なので1000倍してusへ揃える)。
    expect(fixed.getTime() * 1000).toBeGreaterThan(availableAtUs);
  });

  it("同じ入力に対し、+1ms 無しの素の Date（旧実装相当）は追い越せない", () => {
    // 変異の裏返し: `clockPastRecentDbWrites` から +1 を抜いた「旧実装」を模す。
    const availableAtUs = 1_737_953_696_123_456;
    const flooredMs = Math.floor(availableAtUs / 1000);

    const buggy = new Date(flooredMs); // clockPastRecentDbWrites の "nowMs + 1" を欠いた形

    expect(buggy.getTime() * 1000).toBeLessThan(availableAtUs);
  });

  it("端数が無い(ちょうど ms の境界)場合も、+1 側は等号を含めて安全である", () => {
    const availableAtUs = 1_737_953_696_123_000; // 端数ちょうど0
    const flooredMs = Math.floor(availableAtUs / 1000);

    const fixed = clockPastRecentDbWrites(flooredMs);
    expect(fixed.getTime() * 1000).toBeGreaterThan(availableAtUs);
  });

  it("nowMs を省略すると Date.now() を使う既定になる", () => {
    const before = Date.now();
    const result = clockPastRecentDbWrites();
    const after = Date.now();
    // result は [before+1, after+1] の範囲に収まる。
    expect(result.getTime()).toBeGreaterThanOrEqual(before + 1);
    expect(result.getTime()).toBeLessThanOrEqual(after + 1);
  });
});
