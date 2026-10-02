// ADR 0498: provider のコンストラクタが数値オプションを構築時に検査する。公開しない（index.ts から export しない）。
// 値は秘密ではない（apiKey と違う）ので、`resolveConcurrency`（bullmq）・`eraseTenant` と同じく message に入れる。

/** 正の安全な整数（`1` 以上 `Number.MAX_SAFE_INTEGER` 以下の整数）でなければ投げる。 */
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

function describe(value: unknown): string {
  return typeof value === "bigint"
    ? `${String(value)}n`
    : typeof value === "number"
      ? String(value)
      : typeof value;
}
