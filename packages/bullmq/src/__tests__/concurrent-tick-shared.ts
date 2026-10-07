// 親・子とも相対 import で共有する。子プロセスは plain な Node で起動し、vitest の alias が効かないため。

import type { EmbeddingSpaceId } from "../../../core/src/index.js";

export const CONCURRENCY_TEST_EMBEDDING_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "bullmq-concurrency-fixture",
  dimensions: 3,
};

export const FIXED_VECTOR = [0.1, 0.2, 0.3];

export const RESULT_MARKER = "##MNEMORA_BULLMQ_CONCURRENCY_RESULT##";

export interface ChildResult {
  workerId: string;
  embeddedContents: string[];
  tickCalls: number;
}

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
