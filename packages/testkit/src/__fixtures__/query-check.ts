// testkit の fixture の内部モジュール。読みの口（検索・集約・掃除）の関数の中身からだけ使う——`.d.ts` の
// import に出ないので、公開の型の面には入らない（`memory-event-check.ts`・`memory-enum-check.ts` と同じ）。

/**
 * 読みの口の条件の日時が、Postgres の `timestamptz` へ変換できるかを確かめる（Postgres が拒む入力を、同じ入力で拒む）。
 * Invalid Date（`.getTime()` が `NaN`）は、Postgres ではクエリの時点で `22007` になる。省略（`undefined`/`null`）は
 * 条件が無いのであって、検査しない。書く口の Invalid Date の検査（#807）と同じ文面にする。
 */
export function assertQueryDate(
  method: string,
  field: string,
  value: Date | null | undefined,
): void {
  if (value != null && Number.isNaN(value.getTime())) {
    throw new Error(`${method}: ${field} must be a valid Date (got Invalid Date)`);
  }
}

/**
 * 読みの口の条件の通し番号（活動時計の `activity_seq` など）が、Postgres の `bigint` へ変換できる整数かを確かめる。
 * `1.5`・`NaN`・`Infinity` は、Postgres ではクエリの時点で `22P02` になる。省略は検査しない。
 */
export function assertQueryInteger(
  method: string,
  field: string,
  value: number | null | undefined,
): void {
  if (value != null && !Number.isInteger(value)) {
    throw new Error(`${method}: ${field} must be an integer (got ${value})`);
  }
}

/**
 * 読みの口の検索語が、Postgres の `text` へ渡せるかを確かめる（穴 O-6-1、ADR 0424）。NUL (U+0000) は、
 * Postgres ではクエリの時点で `invalid byte sequence for encoding "UTF8": 0x00` になる。
 * 書く口の NUL の検査（#816）と同じ文面にする。
 */
export function assertQueryTextWithoutNul(method: string, field: string, value: string): void {
  if (value.includes("\u0000")) {
    throw new Error(`${method}: ${field} must not contain NUL characters (U+0000)`);
  }
}

/**
 * ベクトルの成分が pgvector の float4 に収まるかを確かめる（穴 O-6-2、ADR 0424）。`Math.fround` が有限に
 * ならない成分（`1e308`・`NaN`・`Infinity`）は、Postgres の upsert では `out of range for type vector` 等になる。
 */
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
