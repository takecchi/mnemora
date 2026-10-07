/** 読みの口の条件の日時が `timestamptz` へ変換できるかを確かめる。Invalid Date は拒み、省略（`undefined`/`null`）は検査しない。 */
export function assertQueryDate(
  method: string,
  field: string,
  value: Date | null | undefined,
): void {
  if (value != null && Number.isNaN(value.getTime())) {
    throw new Error(`${method}: ${field} must be a valid Date (got Invalid Date)`);
  }
}

/** Postgres の `timestamptz` の下限（4714-11-24 BC 00:00:00 UTC）。`packages/postgres/src/mapping.ts` の同名の定数と同じ値。 */
export const PG_TIMESTAMPTZ_MIN_MS = Date.UTC(-4713, 10, 24);

/** `assertQueryDate` に `timestamptz` の下限を足したもの。日時を行に書く口で使う。⚠ 読みの口の条件には使わない（Postgres は下限へ寄せて比べるので、断らない）。 */
export function assertQueryTimestamptz(
  method: string,
  field: string,
  value: Date | null | undefined,
): void {
  assertQueryDate(method, field, value);
  assertWrittenTimestamptzFloor(method, field, value);
}

/**
 * 日時を行に書く欄が `timestamptz` の下限より前でないかを確かめる。Invalid Date は断らない（別の検査が在る）。
 * ⚠ 読みの口の条件には使わない。呼ぶ位置は Postgres がその値を実際に書く分岐の中だけ（書かない分岐では Postgres は値を見ない）。
 */
export function assertWrittenTimestamptzFloor(
  method: string,
  field: string,
  value: Date | null | undefined,
): void {
  if (value != null && value.getTime() < PG_TIMESTAMPTZ_MIN_MS) {
    throw new RangeError(
      `${method}: ${field} must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`,
    );
  }
}

/** 読みの口の通し番号が `bigint` へ変換できる整数かを確かめる。省略は検査しない。 */
export function assertQueryInteger(
  method: string,
  field: string,
  value: number | null | undefined,
): void {
  if (value != null && !Number.isInteger(value)) {
    throw new Error(`${method}: ${field} must be an integer (got ${value})`);
  }
}

/** 読みの口の検索語が `text` へ渡せるかを確かめる（NUL を拒む）。 */
export function assertQueryTextWithoutNul(method: string, field: string, value: string): void {
  if (value.includes("\u0000")) {
    throw new Error(`${method}: ${field} must not contain NUL characters (U+0000)`);
  }
}

/** 読みの口の `labels` の要素に NUL が入っていないかを確かめる。文字列でない要素（型を外した呼び出し）は見ない。 */
export function assertQueryLabelsWithoutNul(
  method: string,
  field: string,
  labels: readonly unknown[] | null | undefined,
): void {
  for (const label of labels ?? []) {
    if (stringHasNul(label)) {
      throw new Error(`${method}: ${field} must not contain NUL characters (U+0000)`);
    }
  }
}

/** ベクトルの成分が pgvector の float4 に収まるかを確かめる。 */
export function assertFloat4Vector(method: string, vector: readonly number[]): void {
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i]!;
    if (!Number.isFinite(Math.fround(x))) {
      throw new RangeError(
        `${method}: vector component [${i}] does not fit in a float4 (pgvector) value (got ${x})`,
      );
    }
  }
}

/** `value` を `jsonb` へ渡すとき、Postgres が NUL（U+0000）で拒むか。JSON として往復させた値を辿るので、文字どおりの `\\u0000`（バックスラッシュ + `u0000`）は NUL として扱わない。 */
export function jsonContainsNul(value: unknown): boolean {
  const text = JSON.stringify(value);
  if (text === undefined || !text.includes("\\u0000")) {
    return false;
  }
  const visit = (v: unknown): boolean => {
    if (typeof v === "string") {
      return v.includes("\u0000");
    }
    if (Array.isArray(v)) {
      return v.some(visit);
    }
    if (v !== null && typeof v === "object") {
      return Object.entries(v).some(([k, inner]) => k.includes("\u0000") || visit(inner));
    }
    return false;
  };
  return visit(JSON.parse(text));
}

/** 文字列の値に NUL が入っているか。文字列でない値は「入っていない」と扱う（Postgres は別の変換をするので、ここでは見ない）。 */
export function stringHasNul(value: unknown): boolean {
  return typeof value === "string" && value.includes("\u0000");
}

/** 読みの口の `jsonb` の条件が、Postgres の `jsonb` へ渡せるかを確かめる（NUL を拒む）。 */
export function assertQueryJsonWithoutNul(method: string, field: string, value: unknown): void {
  if (value != null && jsonContainsNul(value)) {
    throw new Error(`${method}: ${field} must not contain NUL characters (U+0000)`);
  }
}

/** 書く口の通し番号が `bigint` へ変換できる整数かを確かめる。負の数そのものは拒まない（行を書く分岐で別に見る）。 */
export function assertQueryBigint(
  method: string,
  field: string,
  value: number | null | undefined,
): void {
  assertQueryInteger(method, field, value);
  if (value != null && (value >= 2 ** 63 || value < -(2 ** 63))) {
    throw new Error(`${method}: ${field} must fit in a Postgres bigint (got ${value})`);
  }
}

/** Postgres の `integer`（int4）列が持てる範囲。 */
export const INT4_MIN = -(2 ** 31);
export const INT4_MAX = 2 ** 31 - 1;

/** 数の値が `integer`（int4）列へ書けるかを確かめる。負の数そのものは拒まない。数でない値は検査しない。 */
export function assertInt4Column(method: string, field: string, value: unknown): void {
  if (typeof value !== "number") {
    return;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${method}: ${field} must be an integer (got ${value})`);
  }
  if (value < INT4_MIN || value > INT4_MAX) {
    throw new Error(
      `${method}: ${field} does not fit in a Postgres "integer" (int4) column (got ${value})`,
    );
  }
}

/**
 * 活動時計の「いま」に subject 単位のカウンタ `S_x` を足す式の和が、Postgres の `bigint` を溢れるか。
 * ドライバが `base` を文字にした値で足すので、float64 ではなく BigInt で足す。`base` が範囲に収まること（`assertQueryBigint`）を先に確かめてから呼ぶ。
 * 溢れを投げるかどうかは、Postgres がその式を評価する行かどうかで決まる（呼び出し側が見る）。
 */
export function seqSumOverflowsBigint(base: number, ownSeq: number): boolean {
  return BigInt(String(base)) + BigInt(ownSeq) >= 2n ** 63n;
}
