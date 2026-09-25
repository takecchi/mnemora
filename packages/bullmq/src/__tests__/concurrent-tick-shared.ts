// `concurrent-tick.redis.test.ts`（親プロセス）と `concurrent-tick-child.ts`（子プロセス、
// `pnpm exec tsx` で spawn される）の両方が使う定数・型。子プロセスは plain な Node
// プロセスとして起動する（vitest のエイリアス解決は効かない）ため、
// `@mnemora/core`/`@mnemora/postgres` への相対 import と合わせてここも相対 import で共有する。

import type { EmbeddingSpaceId } from "../../../core/src/index.js";

/** このテスト専用の埋め込み空間。次元は小さく、pgvector への書き込みを軽くする。 */
export const CONCURRENCY_TEST_EMBEDDING_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "bullmq-concurrency-fixture",
  dimensions: 3,
};

/** 固定のダミーベクトル。値そのものに意味は無い（次元だけが検査対象）。 */
export const FIXED_VECTOR = [0.1, 0.2, 0.3];

/** 子プロセスが `process.stdout` へ書く、結果を含む1行の目印プレフィックス。 */
export const RESULT_MARKER = "##MNEMORA_BULLMQ_CONCURRENCY_RESULT##";

/** 子プロセスが親へ返す結果の形。 */
export interface ChildResult {
  workerId: string;
  /** この子プロセスが embed した Memory の `content`（一意な文字列）の一覧。 */
  embeddedContents: string[];
  /** この子プロセスで `runtime.tick()` が実際に呼ばれた回数。 */
  tickCalls: number;
}

/** 子プロセスの起動パラメータ（環境変数経由で渡す）。 */
export interface ChildEnvParams {
  DATABASE_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: string;
  QUEUE_NAME: string;
  TENANT_ID: string;
  WORKER_ID: string;
  DURATION_MS: string;
  EVERY_MS: string;
  EMBED_DELAY_MS: string;
  CONCURRENCY: string;
  LEASE_MS: string;
  TICK_LIMIT: string;
}
