import type { Db } from "./client.js";
import {
  INITIAL_ANALYZE_THRESHOLD,
  isGeometricAnalyzeThreshold,
  maybeAnalyzeTableAfterWrite,
} from "./analyze-threshold.js";

/**
 * `memories` 側の自動 ANALYZE（ADR 0221）。`search()` は埋め込み表を `memories` と JOIN してテナントで絞るので、
 * `memories` の統計がずれていると、プランナは HNSW 索引を検討する前に行数を見誤って Nested Loop を選ぶ。
 * 設計は `embedding-statistics.ts`（ADR 0194）と同じで、核は `analyze-threshold.ts` を共有する。
 *
 * `PostgresMemoryStore` が `memories` へ実際に新しい行を INSERT した経路の末尾から呼ぶ。
 * ON CONFLICT で既存行を返しただけの呼び出しは数えない。`createMemoryWithOutbox` ではトランザクションの外側で呼ぶ
 * （トランザクションが持つ行ロックと `ShareUpdateExclusiveLock` を無用に重ねないため。ADR 0221）。
 */

const MEMORIES_TABLE = "memories";

/** プロセスローカルの `memories` 書き込み累計カウンタ。`maybeAnalyzeTableAfterWrite` がテーブル名をキーにした `Map` を要求するので、1エントリだけ使う。 */
const memoriesWriteCounts = new Map<string, number>();

/** テスト専用: プロセスローカルのカウンタを空にする。production コードからは呼ばない。 */
export function resetMemoriesWriteCounterForTesting(): void {
  memoriesWriteCounts.clear();
}

/** テスト専用: プロセスローカルのカウンタの現在値を覗く。production コードからは呼ばない。 */
export function peekMemoriesWriteCounterForTesting(): number {
  return memoriesWriteCounts.get(MEMORIES_TABLE) ?? 0;
}

export interface MaybeAnalyzeMemoriesResult {
  /** この呼び出しを含む、このプロセスが `memories` に書き込んだ累計行数。 */
  count: number;
  /** この呼び出しで実際に `ANALYZE memories` を撃ったかどうか。 */
  analyzed: boolean;
}

/**
 * `PostgresMemoryStore` の書き込み経路の末尾から呼ぶ。カウンタを1増やし、等比の閾値を跨いだときだけ
 * `pg_class.reltuples` を読み、それがこのプロセスの書いた累計行数より小さければ `ANALYZE memories` を撃つ。
 */
export async function maybeAnalyzeMemoriesAfterWrite(db: Db): Promise<MaybeAnalyzeMemoriesResult> {
  const result = await maybeAnalyzeTableAfterWrite(db, MEMORIES_TABLE, memoriesWriteCounts);
  return { count: result.count, analyzed: result.analyzed };
}

export { INITIAL_ANALYZE_THRESHOLD, isGeometricAnalyzeThreshold };
