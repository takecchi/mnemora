import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresClient,
  PostgresMemoryStore,
  registerEmbeddingSpace,
  runMigrations,
} from "@mnemora/postgres";
import type { PostgresClient } from "@mnemora/postgres";
import type { NewMemory } from "@mnemora/core";
import { CONCURRENCY_TEST_EMBEDDING_SPACE } from "./concurrent-tick-shared.js";
import type { ChildEnvParams, ChildResult } from "./concurrent-tick-shared.js";

/**
 * 起爆ジョブ（空の job）を `queue.addBulk` でまとめ撃ちし、ラウンドを複数回す。repeat ジョブだけでは変異の検出率が8試行中7回に留まったため。
 * 合計が用意した本数と一致することは検査しない。`FOR UPDATE SKIP LOCKED` 相当は競合下で拾い残すことを許容している（次の tick が拾う）。
 * 子プロセスは相対 import で src を読むので、変異試験の変異はビルド無しで反映される。
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `concurrent-tick.redis.test: missing env ${name}。この歯は test:redis 専用であり、` +
        "本物の Postgres（DATABASE_URL）と本物の Redis（REDIS_HOST/REDIS_PORT）を要る。",
    );
  }
  return value;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = requireEnv("REDIS_PORT");

const CHILD_SCRIPT = fileURLToPath(new URL("./concurrent-tick-child.ts", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runChild(env: ChildEnvParams): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", CHILD_SCRIPT], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const marker = "##MNEMORA_BULLMQ_CONCURRENCY_RESULT##";
      const line = stdout.split("\n").find((l) => l.startsWith(marker));
      if (code !== 0 || !line) {
        reject(
          new Error(
            `concurrent-tick-child exited code=${String(code)}, stdout=${stdout}\nstderr=${stderr}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice(marker.length)) as ChildResult);
    });
  });
}

let client: PostgresClient;

beforeAll(async () => {
  client = createPostgresClient(DATABASE_URL);
  await runMigrations(client.pool);
  await registerEmbeddingSpace(client.pool, CONCURRENCY_TEST_EMBEDDING_SPACE);
}, 60_000);

afterAll(async () => {
  await client.pool.end();
});

describe("BullMQ 経由の複数プロセス同時 tick は outbox ジョブを二重処理しない", () => {
  it("K 個の子プロセス（各自の pg.Pool + BullMQ Worker）に対し、ROUNDS 回の独立したラウンドで同時 tick を起こしても、同じジョブが2プロセス以上に処理されない", async () => {
    const runId = randomUUID();
    const tenantId = `bullmq-concurrency-${runId}`;
    const queueName = `mnemora-bullmq-concurrency-${runId}`;

    // これらの定数は変異試験で実測して決めた値（ラウンドを複数回す形に変えて検出率が上がった）。
    const CHILD_COUNT = 4;
    const CONCURRENCY_PER_CHILD = 4;
    const TOTAL_WORKERS = CHILD_COUNT * CONCURRENCY_PER_CHILD;
    const EVERY_MS = 3_000;
    const EMBED_DELAY_MS = 30;
    const LEASE_MS = 5 * 60 * 1000;
    // 1回の tick が拾う件数をわざと最小にする（limit=1）。
    const TICK_LIMIT = 1;

    const ROUNDS = 10;
    // ラウンドあたりの候補行は、全ワーカー数よりずっと少なくして競合を厚くする。
    const BATCH_SIZE = 3;
    // 起爆ジョブは全ワーカー数以上にして、ラウンド直後にほぼ全ワーカーが同時に claimBatch を呼ぶようにする。
    const BURST_SIZE = TOTAL_WORKERS + 8;
    const PER_ROUND_PAUSE_MS = 400;
    const STARTUP_MARGIN_MS = 1_000;
    const DRAIN_BUFFER_MS = 2_000;
    const DURATION_MS = STARTUP_MARGIN_MS + ROUNDS * PER_ROUND_PAUSE_MS + DRAIN_BUFFER_MS + 1_500;

    const memoryStore = new PostgresMemoryStore(client.db);
    const expectedContents: string[] = [];

    async function seedRound(round: number): Promise<void> {
      for (let i = 0; i < BATCH_SIZE; i += 1) {
        const content = `bullmq-concurrency-${runId}-r${round}-${i}`;
        expectedContents.push(content);
        const input: NewMemory = {
          tenantId,
          content,
          contentHash: hashContent(content),
          digest: content.slice(0, 40),
          digestSource: "fallback",
          // `imported` は provenance の CHECK に当たらないので、observations 行を用意しなくてよい。
          provenance: { kind: "imported", batchId: `bullmq-concurrency-test-r${round}` },
          tags: [],
          recordedAt: new Date(),
          strength: 1,
          halfLifeHours: 24,
          decayFloorAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          embeddingStatus: "pending",
        };
        const { created } = await memoryStore.createMemoryWithOutbox({ tenantId }, input, [
          "embed",
        ]);
        expect(created).toBe(true);
      }
    }

    const childEnvs: ChildEnvParams[] = Array.from({ length: CHILD_COUNT }, (_, i) => ({
      DATABASE_URL,
      REDIS_HOST,
      REDIS_PORT,
      QUEUE_NAME: queueName,
      TENANT_ID: tenantId,
      WORKER_ID: `child-${i}`,
      DURATION_MS: String(DURATION_MS),
      EVERY_MS: String(EVERY_MS),
      EMBED_DELAY_MS: String(EMBED_DELAY_MS),
      CONCURRENCY: String(CONCURRENCY_PER_CHILD),
      LEASE_MS: String(LEASE_MS),
      TICK_LIMIT: String(TICK_LIMIT),
    }));

    const childResultsPromise = Promise.all(childEnvs.map((env) => runChild(env)));

    const tickQueue = new Queue(queueName, {
      connection: { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null },
    });

    await sleep(STARTUP_MARGIN_MS);

    for (let round = 0; round < ROUNDS; round += 1) {
      await seedRound(round);
      await tickQueue.addBulk(
        Array.from({ length: BURST_SIZE }, () => ({ name: "mnemora-tick", data: {} })),
      );
      await sleep(PER_ROUND_PAUSE_MS);
    }

    await sleep(DRAIN_BUFFER_MS);
    await tickQueue.close();

    const results = await childResultsPromise;

    const allEmbedded = results.flatMap((r) => r.embeddedContents);
    const duplicates = allEmbedded.filter((c, i) => allEmbedded.indexOf(c) !== i);

    // 空回り防止。何も embed されていないまま「重複0件」で緑にしない（探り棒が動いていない可能性と区別できない）。
    const totalTickCalls = results.reduce((sum, r) => sum + r.tickCalls, 0);
    expect(
      totalTickCalls,
      "どの子プロセスも tick を1回も呼んでいない。BullMQ の配線か Redis 接続を疑うこと。",
    ).toBeGreaterThan(0);
    expect(
      allEmbedded.length,
      "どの子プロセスも1件も embed していない。outbox にジョブが積めていないか、" +
        "claimBatch が何も返していない。",
    ).toBeGreaterThan(0);
    // 用意していない content を embed していたら別の欠陥なので、素通しせず見えるようにする。
    for (const content of allEmbedded) {
      expect(expectedContents).toContain(content);
    }

    expect(
      duplicates,
      `同じ Memory が複数プロセスに処理された（二重 embed）: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);

    // 合計が用意した本数と一致することは検査しない（拾い残しは次の tick が拾う設計のため）。
    console.log(
      `[concurrent-tick] rounds=${ROUNDS} batchSize=${BATCH_SIZE} memories=${expectedContents.length} ` +
        `embedded(total)=${allEmbedded.length} tickCalls(total)=${totalTickCalls} ` +
        `duplicates=${duplicates.length}`,
    );
  });
  // vitest.redis.config.mts の testTimeout（120秒）に収まる長さにしてある.
});
