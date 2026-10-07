import { describe, expect, it } from "vitest";
import {
  assertValidEventRetentionDays,
  EVENT_RETENTION_DAYS_INVALID_MESSAGE,
} from "../interfaces/tenant-settings-store.js";

describe("assertValidEventRetentionDays（ADR 0499）", () => {
  it.each([1, 2, 365, 2 ** 31 - 2, 2 ** 31 - 1])("%d は通る", (days) => {
    expect(() => assertValidEventRetentionDays(days)).not.toThrow();
  });

  it.each([2 ** 31, 2 ** 31 + 1, 2 ** 53, Number.MAX_SAFE_INTEGER])(
    "%d は int4 に収まらないので、名指しの Error で断る",
    (days) => {
      expect(() => assertValidEventRetentionDays(days)).toThrow(
        `setEventRetention: days does not fit in a Postgres "integer" (int4) column (got ${days})`,
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "%d は、今までの文面（正の整数でない）で断る",
    (days) => {
      expect(() => assertValidEventRetentionDays(days)).toThrow(
        EVENT_RETENTION_DAYS_INVALID_MESSAGE,
      );
    },
  );
});
