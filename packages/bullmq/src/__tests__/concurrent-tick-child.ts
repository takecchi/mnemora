// 子プロセスの実体（`concurrent-tick.redis.test.ts` から `pnpm exec tsx` で spawn される）。
//
// 🔴 **`@mnemora/core`/`@mnemora/postgres` を相対 import で読む（bare specifier で
// `import ... from "@mnemora/postgres"` としない）。** この歯は変異試験
// （`packages/postgres/src/outbox-store.ts` を `cp` で退避 → 変異 → 撃つ → `cp` で戻す、
// AGENTS.md「⛔ 変異を戻すのに `git checkout` を使わない」節）から使うことを前提にしている。
// 子プロセスは vitest の外（plain な `tsx` 実行）なので、Node の通常の module 解決が効く
// ——bare specifier だと `packages/bullmq/node_modules/@mnemora/postgres` → `dist/index.js`
// に解決され、**変異のたびに `pnpm --filter @mnemora/postgres run build` を挟まないと
// 反映されない**（`vitest.redis.config.mts` の alias は親プロセスにしか効かない）。
// 相対 import ならビルド無しで src を直接読むので、変異が即座に反映される。
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

/**
 * 呼ばれるたびに `texts` をそのまま記録するだけの `EmbeddingProvider`。
 * 「本物と偽物を分ける」のは Postgres と Redis であって embedding provider ではない
 * （本 PR の決定5「embedding provider 等は数を数える fake でよい」）。
 * `EMBED_DELAY_MS` を挟むのは、BullMQ の repeat ジョブが処理時間より短い間隔で
 * 発火し続けたときに複数インスタンスが積み上がり、複数プロセスの Worker が
 * 同時にそれらを拾う（＝同じテナントに対して複数の `runtime.tick()` が実際に重なる）
 * 状況を確実に作るため。
 */
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

/** embed ジョブの処理経路では呼ばれない。呼ばれたら歯の前提が崩れているので投げる。 */
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

  // 🔴 自分専用の pg.Pool（決定5「複数の子プロセスが、それぞれ自分の pg.Pool …を持ち」）。
  const client = createPostgresClient(databaseUrl);

  // 🔴 **接続を先に温める**（ADR 0206「測ったこと2」「案F」と同じ実測に基づく）。
  // `pg.Pool` は遅延接続なので、ここで並行数ぶんの接続を先に張っておかないと、
  // 最初の tick 群の接続確立の時間差そのものが「競争の窓」を閉じてしまい、
  // `FOR UPDATE SKIP LOCKED` を丸ごと削った変異を入れても偶然赤くならないことが
  // ある（本 PR で実測——温めずに3試行したところ 1/3 しか検出できなかった）。
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
      // 個々の tick 呼び出しの失敗（embed 自体の失敗等）は TickResult.failed に
      // 現れるので、ここに来るのは Worker/接続レベルの異常。落とさず観測だけする。
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
