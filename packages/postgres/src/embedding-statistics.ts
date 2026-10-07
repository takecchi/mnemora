import type { EmbeddingSpaceId } from "@mnemora/core";
import type { Db } from "./client.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";
import {
  INITIAL_ANALYZE_THRESHOLD,
  isGeometricAnalyzeThreshold,
  maybeAnalyzeTableAfterWrite,
} from "./analyze-threshold.js";

export { INITIAL_ANALYZE_THRESHOLD, isGeometricAnalyzeThreshold };

/**
 * 新しい埋め込み空間へ大量投入した直後は、`pg_class.reltuples` が更新されるまで `search()` が HNSW 索引を選ばない
 * （ADR 0194）。そこで、このプロセスが `upsert` で書いた行数を空間ごとに数え、等比の閾値（{@link INITIAL_ANALYZE_THRESHOLD}
 * から倍々）ちょうどで `reltuples` を読み、それが書いた行数より小さいときだけ `ANALYZE` を撃つ。
 *
 * - カウンタはプロセスローカル。再起動で0に戻り、複数プロセスは各自のカウンタで判定する。確認や `ANALYZE` が余計に
 *   走りうるが、`reltuples` の guard があり冪等なので害は無い。プロセス間の協調機構は意図して置かない。
 * - `ANALYZE` は `ShareUpdateExclusiveLock` を取る。同じ表への `ANALYZE` 同士は直列化するが、通常の読み書きとは競合しない。
 * - `registerEmbeddingSpace` の直後には撃たない。その時点で表は空で、撃つ意味が無い。
 */

/**
 * プロセスローカルの upsert 累計カウンタ。キーは `EmbeddingSpaceId` でなく導出済みのテーブル名にする
 * （同じテーブルを指す値が複数生成されても同じキーに落とすため）。
 */
const upsertCountsByTable = new Map<string, number>();

/** テスト専用: プロセスローカルのカウンタを空にする。production コードからは呼ばない。 */
export function resetEmbeddingUpsertCountersForTesting(): void {
  upsertCountsByTable.clear();
}

export interface MaybeAnalyzeAfterUpsertResult {
  /** 対象テーブル名。 */
  table: string;
  /** この呼び出しを含む、このプロセスがこのテーブルに `upsert` した累計行数。 */
  count: number;
  /** この呼び出しで実際に `ANALYZE` を撃ったかどうか。 */
  analyzed: boolean;
}

/**
 * `PostgresVectorStore.upsert` の末尾から呼ぶ。テーブル名を `EmbeddingSpaceId` から導出し、
 * カウント・閾値判定・`ANALYZE` の要否判定は {@link maybeAnalyzeTableAfterWrite} に委譲する。
 */
export async function maybeAnalyzeAfterUpsert(
  db: Db,
  space: EmbeddingSpaceId,
): Promise<MaybeAnalyzeAfterUpsertResult> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  return maybeAnalyzeTableAfterWrite(db, table, upsertCountsByTable);
}
