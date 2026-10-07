/** 正の安全な整数でなければ投げる。値は秘密ではないので message に入れる。 */
export function assertPositiveSafeInteger(owner: string, field: string, value: unknown): void {
  if (typeof value !== "number") {
    throw new TypeError(
      `${owner}: ${field} must be a positive safe integer, got ${describe(value)}`,
    );
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `${owner}: ${field} must be a positive safe integer, got ${describe(value)}`,
    );
  }
}

/** 有限で `0` 以上の数でなければ投げる（上限は API ごとに違うので見ない）。 */
export function assertFiniteNonNegative(owner: string, field: string, value: unknown): void {
  if (typeof value !== "number") {
    throw new TypeError(`${owner}: ${field} must be a finite number >= 0, got ${describe(value)}`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${owner}: ${field} must be a finite number >= 0, got ${describe(value)}`);
  }
}

function describe(value: unknown): string {
  return typeof value === "bigint"
    ? `${String(value)}n`
    : typeof value === "number"
      ? String(value)
      : typeof value;
}
