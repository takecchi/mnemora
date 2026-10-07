// `@mnemora/core`/`@mnemora/postgres` は相対 import で読む（bare specifier にしない）。子プロセスは vitest の外で動くので、bare specifier だと `dist` に解決され、変異試験のたびに build を挟まないと反映されない。
import { createHash } from "node:crypto";
import { createRuntime } from "../../../core/src/index.js";
import type {
  Ctx,
  EmbeddingProvider,
  LLMProvider,
  PromptSpec,
  Runtime,
  StructuredRequest,
} from "../../../core/src/index.js";
import {
  createPostgresClient,
  PostgresEventStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresVectorStore,
} from "../../../postgres/src/index.js";
import { createBullmqTickDriver } from "../tick-driver.js";
import {
  CONCURRENCY_TEST_EMBEDDING_SPACE,
  FIXED_VECTOR,
  RESULT_MARKER,
} from "./concurrent-tick-shared.js";
import type { ChildResult } from "./concurrent-tick-shared.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`concurrent-tick-child: missing env ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Postgres と Redis は本物にし、embedding provider は呼び出しを記録するだけの fake にする。 */
class RecordingEmbeddingProvider implements EmbeddingProvider {
  readonly space = CONCURRENCY_TEST_EMBEDDING_SPACE;
  readonly calls: string[] = [];
  constructor(private readonly delayMs: number) {}

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }
    this.calls.push(...texts);
    return texts.map(() => FIXED_VECTOR);
  }
}

const throwingLlmProvider: LLMProvider = {
  complete(_ctx: Ctx, _req: PromptSpec) {
    throw new Error("concurrent-tick-child: LLMProvider.complete は呼ばれない想定");
  },
  completeStructured<T>(_ctx: Ctx, _req: StructuredRequest<T>) {
    throw new Error("concurrent-tick-child: LLMProvider.completeStructured は呼ばれない想定");
  },
};

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const redisHost = requireEnv("REDIS_HOST");
  const redisPort = Number(requireEnv("REDIS_PORT"));
  const queueName = requireEnv("QUEUE_NAME");
  const tenantId = requireEnv("TENANT_ID");
  const workerId = requireEnv("WORKER_ID");
  const durationMs = Number(requireEnv("DURATION_MS"));
  const everyMs = Number(requireEnv("EVERY_MS"));
  const embedDelayMs = Number(requireEnv("EMBED_DELAY_MS"));
  const concurrency = Number(requireEnv("CONCURRENCY"));
  const leaseMs = Number(requireEnv("LEASE_MS"));
  const tickLimit = Number(requireEnv("TICK_LIMIT"));

  const client = createPostgresClient(databaseUrl);

  // 接続を先に温める。`pg.Pool` は遅延接続で、温めないと最初の tick 群の接続確立の時間差が競争の窓を閉じ、`FOR UPDATE SKIP LOCKED` を削る変異が偶然赤くならないことがある。
  await Promise.all(
    Array.from({ length: concurrency }, () => client.pool.query("SELECT pg_sleep(0.05)")),
  );

  const embeddingProvider = new RecordingEmbeddingProvider(embedDelayMs);

  const runtime: Runtime = createRuntime({
    memoryStore: new PostgresMemoryStore(client.db),
    outboxStore: new PostgresOutboxStore(client.db),
    vectorStore: new PostgresVectorStore(client.db),
    eventStore: new PostgresEventStore(client.db),
    tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
    llmProvider: throwingLlmProvider,
    embeddingProvider,
    hashContent,
  });

  const ctx: Ctx = { tenantId };
  let tickCalls = 0;

  const driver = createBullmqTickDriver({
    connection: { host: redisHost, port: redisPort, maxRetriesPerRequest: null },
    queueName,
    runtime,
    ctx,
    tick: { leaseMs, kinds: ["embed"], limit: tickLimit },
    everyMs,
    concurrency,
    jobName: "mnemora-tick",
    onTickResult: () => {
      tickCalls += 1;
    },
    onTickError: (err) => {
      // ここに来るのは Worker/接続レベルの異常。落とさず観測だけする。
      process.stderr.write(`[${workerId}] worker error: ${String(err)}\n`);
    },
  });

  await driver.start();
  await sleep(durationMs);
  await driver.stop();
  await client.pool.end();

  const result: ChildResult = {
    workerId,
    embeddedContents: embeddingProvider.calls,
    tickCalls,
  };
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `concurrent-tick-child fatal: ${String(err instanceof Error ? err.stack : err)}\n`,
  );
  process.exit(1);
});
