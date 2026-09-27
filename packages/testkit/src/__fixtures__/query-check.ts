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
