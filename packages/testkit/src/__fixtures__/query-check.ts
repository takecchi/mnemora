// testkit の fixture の内部モジュール。読み・書きの口（検索・集約・掃除・書き込み）の関数の中身からだけ使う——`.d.ts` の
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
 * Postgres の `timestamptz` の下限（4714-11-24 BC 00:00:00 UTC。天文学的年 -4713）。これより前の日時は、Postgres では
 * 値が渡された時点で `22008 timestamp out of range` になる（`packages/postgres/src/memory-store.ts` の同名の定数と同じ値）。
 */
export const PG_TIMESTAMPTZ_MIN_MS = Date.UTC(-4713, 10, 24);

/**
 * `assertQueryDate` に、`timestamptz` の下限（ADR 0500）を足したもの。Postgres が日時を `timestamptz` として **クエリに渡す口**
 * （検索・集約・claim key の条件、`opts.now`・`opts.at` など）で使う。下限より前（紀元前4713年11月24日より前）は、Postgres では
 * `22008` になる。
 *
 * ⚠ **全部の口で使うわけではない。**`purgeExpiredEvents`・`purgeExpiredRecalls`・`purgeCompletedJobs` の `olderThan` は、
 * Postgres が下限より前を「対象 0 件」として返す（問い合わせない）ので、`assertQueryDate`（`NaN` だけ）のまま。
 * 口ごとの実測の表は ADR 0500。
 */
export function assertQueryTimestamptz(
  method: string,
  field: string,
  value: Date | null | undefined,
): void {
  assertQueryDate(method, field, value);
  if (value != null && value.getTime() < PG_TIMESTAMPTZ_MIN_MS) {
    throw new RangeError(
      `${method}: ${field} must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`,
    );
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
 * 読みの口の `labels`（`text[]` の引数）の要素に NUL が入っていないかを確かめる（ADR 0456 H3、ADR 0500）。Postgres は
 * `invalid byte sequence for encoding "UTF8": 0x00` で、クエリの時点で拒む。`assertQueryTextWithoutNul` と同じ文面にする。
 * 省略（`undefined`/`null`）は検査しない。文字列でない要素（型を外した呼び出し）は見ない。
 */
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

/**
 * `value` を `jsonb` 列・`jsonb` の引数へ渡すとき、Postgres が NUL（U+0000）で拒むかどうか。
 *
 * `packages/postgres` は `jsonb` 列へ `JSON.stringify(value)` を送る。Postgres は、
 * 文字列の値にもキーにも `\u0000` が現れると `unsupported Unicode escape sequence` で拒む
 * （実測）。同じ文字列を JSON として往復させた値を辿るので、`toJSON` などによる変換も
 * Postgres が受け取る形と同じになる。文字どおりの `\\u0000`（バックスラッシュ + `u0000`）は
 * NUL ではないので拒まない。
 */
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

/**
 * 文字列の値に NUL（U+0000）が入っているか。文字列でない値（型を外した呼び出し）は「入っていない」と
 * 扱う——Postgres は文字列以外を `text` の引数へ渡すと別の変換をするので、ここでは見ない。
 */
export function stringHasNul(value: unknown): boolean {
  return typeof value === "string" && value.includes("\u0000");
}

/**
 * 読みの口の `jsonb` の条件（`attributes` の包含判定など）が、Postgres の `jsonb` へ渡せるかを確かめる。
 * NUL は、Postgres ではクエリの時点で `unsupported Unicode escape sequence`（22P05）になる。
 * `assertQueryTextWithoutNul` と同じ文面にする。省略（`undefined`/`null`）は検査しない。
 */
export function assertQueryJsonWithoutNul(method: string, field: string, value: unknown): void {
  if (value != null && jsonContainsNul(value)) {
    throw new Error(`${method}: ${field} must not contain NUL characters (U+0000)`);
  }
}

/**
 * 書く口の通し番号（`reinforce` の `nowSeq`）が、Postgres の `bigint` の引数へ変換できる整数かを確かめる。整数でない
 * （`NaN`・`Infinity` を含む）→ `22P02`、2^63 以上・-2^63 未満 → `22003`。読みの口の `assertQueryInteger` に、
 * `bigint` の範囲の検査を足したもの。負の数そのものは拒まない（列の CHECK 制約は、行を実際に書くときに効く。
 * 呼び出し側が、書く分岐で別に見る）。省略は検査しない。
 */
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

/**
 * 数の値が、Postgres の `integer`（int4）列へ書けるかを確かめる。整数でない（`NaN`・`Infinity` を含む）→
 * `22P02`、`-2^31` 未満・`2^31 - 1` より大きい → `22003`。負の数そのものは拒まない（列に CHECK 制約は無い）。
 * 数でない値（`null`・`undefined`・型を外した呼び出し）は検査しない。
 */
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
 * ADR 0505: 活動時計の「いま」に subject 単位のカウンタ `S_x` を足す式（`archiveDecayed` の `nowSeq + S_x`、
 * `aggregateScope`・`VectorStore.search` の `decayFloorSeqAfter + S_x`）の和が、Postgres の `bigint` を溢れるか
 * （2^63 以上。溢れれば `22003 bigint out of range` で文ごと失敗する）。足すのは、ドライバが `base` を文字にした値
 * （`String(2**63 - 1024)` は `"9223372036854775000"`）なので、float64 の和ではなく BigInt で同じ値を足す。
 * `base` が `bigint` の範囲に収まること（`assertQueryBigint`）を先に確かめてから呼ぶこと。
 * 溢れを**投げるかどうか**は、Postgres がその式を実際に評価する行かどうかで決まる——呼び出し側が見る。
 */
export function seqSumOverflowsBigint(base: number, ownSeq: number): boolean {
  return BigInt(String(base)) + BigInt(ownSeq) >= 2n ** 63n;
}
