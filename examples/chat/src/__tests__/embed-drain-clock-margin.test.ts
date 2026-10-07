import { describe, expect, it } from "vitest";
import { clockPastRecentDbWrites } from "../embed-drain.js";

// 時刻はモックせず、nowMs を直接渡す（Date をモックすると、new Date() の内部実装に依存してしまう）。
describe("examples/chat: clockPastRecentDbWrites（Issue #719、DB不要・決定的）", () => {
  it("available_at の us精度の値を floor(ms) した同じ瞬間からでも、必ずその値を追い越す", () => {
    const availableAtUs = 1_737_953_696_123_456;
    const flooredMs = Math.floor(availableAtUs / 1000); // JS Date が持てる最小の値

    const fixed = clockPastRecentDbWrites(flooredMs);

    expect(fixed.getTime() * 1000).toBeGreaterThan(availableAtUs);
  });

  it("同じ入力に対し、+1ms 無しの素の Date（旧実装相当）は追い越せない", () => {
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
    expect(result.getTime()).toBeGreaterThanOrEqual(before + 1);
    expect(result.getTime()).toBeLessThanOrEqual(after + 1);
  });
});
