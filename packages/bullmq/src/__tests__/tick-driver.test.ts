import { describe, expect, it } from "vitest";
import { resolveConcurrency } from "../tick-driver.js";

// Redis を要らない純関数だけの検査（既定の `test` はここで完結する）。
// `createBullmqTickDriver` 自体（Queue/Worker を実際に作る側）は Redis 接続を要るため、
// `concurrent-tick.redis.test.ts`（`test:redis`、専用 CI job）側で検査する。
describe("resolveConcurrency", () => {
  it("省略時は1", () => {
    expect(resolveConcurrency(undefined)).toBe(1);
  });

  it("正の整数はそのまま返す", () => {
    expect(resolveConcurrency(1)).toBe(1);
    expect(resolveConcurrency(4)).toBe(4);
  });

  it("0以下は投げる", () => {
    expect(() => resolveConcurrency(0)).toThrow(/positive integer/);
    expect(() => resolveConcurrency(-1)).toThrow(/positive integer/);
  });

  it("整数でなければ投げる", () => {
    expect(() => resolveConcurrency(1.5)).toThrow(/positive integer/);
  });
});
