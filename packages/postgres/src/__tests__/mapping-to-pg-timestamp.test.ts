import { describe, expect, it } from "vitest";
import { toPgTimestamp } from "../mapping.js";

/** `toISOString()` は5桁以上の年と紀元前を `+010000-...` / `-000001-...` の形にして Postgres が読めないため、年と紀元前を自分で書く。 */
describe("toPgTimestamp: Date を UTC の timestamptz 文字列にする（Issue #1040）", () => {
  const cases: [iso: string, expected: string][] = [
    ["2026-02-01T00:00:00.123Z", "2026-02-01T00:00:00.123+00:00"],
    ["1850-01-01T00:00:00.000Z", "1850-01-01T00:00:00.000+00:00"],
    ["0005-03-04T05:06:07.008Z", "0005-03-04T05:06:07.008+00:00"],
    ["0001-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000+00:00"],
    ["0000-06-01T00:00:00.000Z", "0001-06-01T00:00:00.000+00:00 BC"],
    ["-000100-03-01T00:00:00.000Z", "0101-03-01T00:00:00.000+00:00 BC"],
    ["+010000-01-01T00:00:00.000Z", "10000-01-01T00:00:00.000+00:00"],
    ["+275760-09-13T00:00:00.000Z", "275760-09-13T00:00:00.000+00:00"],
  ];

  for (const [iso, expected] of cases) {
    it(`${iso} → ${expected}`, () => {
      expect(toPgTimestamp(new Date(iso))).toBe(expected);
    });
  }

  it("プロセスの TZ に左右されない（Asia/Tokyo の地方平均時の時代でも秒を落とさない）", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      expect(toPgTimestamp(new Date("1850-01-01T00:00:00.000Z"))).toBe(
        "1850-01-01T00:00:00.000+00:00",
      );
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }
  });

  it("null / undefined は null（SQL の NULL）", () => {
    expect(toPgTimestamp(null)).toBeNull();
    expect(toPgTimestamp(undefined)).toBeNull();
  });
});
