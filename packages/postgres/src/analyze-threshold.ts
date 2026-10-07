import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * 「このプロセスが書いた行数を数え、等比の閾値ちょうどで `pg_class.reltuples` を1回読み、統計が足りないときだけ
 * `ANALYZE` を撃つ」仕組みの核（ADR 0194）。対象テーブル名に依存しない。
 * 呼び出し元（`embedding-statistics.ts` / `memories-statistics.ts`）は、対象テーブルの決め方とカウンタの置き場だけを持つ。
 */

/** 等比の閾値の初項。以後は倍々（1,000 / 2,000 / 4,000 / …）。 */
export const INITIAL_ANALYZE_THRESHOLD = 1000;

/**
 * `count` が、初項 `initialThreshold` の等比数列（`initialThreshold`, `×2`, `×4`, …）のちょうどどれかに一致するかを返す純関数。
 *
 * 呼び出し側は書き込みのたびに累計を1ずつ増やすので、「閾値を跨いだ」と「ちょうど閾値になった」は同値になる。
 * `count < initialThreshold` は常に false。`initialThreshold` の倍数でも2の累乗倍でなければ false（3000 → false、4000 → true）。
 */
export function isGeometricAnalyzeThreshold(
  count: number,
  initialThreshold: number = INITIAL_ANALYZE_THRESHOLD,
): boolean {
  if (
    !Number.isInteger(count) ||
    !Number.isInteger(initialThreshold) ||
    initialThreshold <= 0 ||
    count < initialThreshold
  ) {
    return false;
  }
  if (count % initialThreshold !== 0) {
    return false;
  }
  const ratio = count / initialThreshold;
  return (ratio & (ratio - 1)) === 0;
}

/**
 * `pg_class.reltuples` を1回読む。一度も ANALYZE されていない表は `-1`（PG14+）。
 * `to_regclass` が解決できない（行が無い）ときは `undefined`で、呼び出し側は「統計が無い」と同じ扱いにする。
 */
export async function readReltuples(db: Db, table: string): Promise<number | undefined> {
  const result = await db.execute(sql`
    SELECT reltuples FROM pg_class WHERE oid = to_regclass(${table})
  `);
  const row = result.rows[0] as { reltuples: unknown } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return Number(row.reltuples);
}

export interface MaybeAnalyzeTableResult {
  /** 対象テーブル名。 */
  table: string;
  /** この呼び出しを含む、このプロセスがこのテーブルに書き込んだ累計行数。 */
  count: number;
  /** この呼び出しで実際に `ANALYZE` を撃ったかどうか。 */
  analyzed: boolean;
}

/**
 * 書き込みのたびに呼ぶ。`counters` の `table` の値を1増やし、等比の閾値（{@link isGeometricAnalyzeThreshold}）を
 * 跨いだときだけ `reltuples` を読み、このプロセスの書いた累計行数より小さければ `ANALYZE <table>` を撃つ。
 * 閾値に達していない呼び出しは、カウンタの加算以外のコストを払わない。
 *
 * `table` は安全な識別子であることが呼び出し元の責務（`sql.identifier` に渡すため）。
 */
export async function maybeAnalyzeTableAfterWrite(
  db: Db,
  table: string,
  counters: Map<string, number>,
  initialThreshold: number = INITIAL_ANALYZE_THRESHOLD,
): Promise<MaybeAnalyzeTableResult> {
  const count = (counters.get(table) ?? 0) + 1;
  counters.set(table, count);

  if (!isGeometricAnalyzeThreshold(count, initialThreshold)) {
    return { table, count, analyzed: false };
  }

  const reltuples = await readReltuples(db, table);
  if (reltuples !== undefined && reltuples >= count) {
    return { table, count, analyzed: false };
  }

  await db.execute(sql`ANALYZE ${sql.identifier(table)}`);
  return { table, count, analyzed: true };
}
