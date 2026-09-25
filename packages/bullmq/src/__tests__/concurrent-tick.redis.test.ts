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
 * Issue #205 の2本目（`packages/bullmq`）本体の歯——ADR 0325「測ったこと」。
 *
 * ## この歯が測っているもの
 *
 * **複数の子プロセス**（それぞれ自分専用の `pg.Pool` と BullMQ `Worker` を持つ、
 * `node:child_process.spawn` で実際に立てた別 OS プロセス）が、**同じテナントの
 * outbox に対して同時に `runtime.tick()` を呼んでも、同じ embed ジョブ（＝同じ
 * Memory）を二重に処理しない**ことを、本物の Postgres・本物の Redis に対して検査する。
 *
 * ADR 0206 が測ったのは「単一プロセス内の複数接続（`Promise.all`）」までだった
 * （同 ADR「引き受けた負債」2・`docs/architecture.md`「確かめていないこと」）。
 * **この歯はその先——複数 OS プロセス・複数 `pg.Pool`——を測る。**
 *
 * ## どうやって「同時」を作るか（2026-09-25 改訂。ADR 0325「測ったこと」参照）
 *
 * **当初は BullMQ の repeat ジョブ（発火間隔 `EVERY_MS` < embed 処理の遅延
 * `EMBED_DELAY_MS`）だけに頼っていたが、変異 (i) の検出率が最終パラメータでも
 * 8試行中7回に留まった。** ADR 0206「測ったこと3」の知見（ラウンド数を増やすと
 * 見逃しが消える）に倣い、**この `it` の中で独立したラウンドを複数回す**形に改めた:
 *
 * 1. 子プロセスは先に起動し、自分専用の `pg.Pool`（接続を事前に温め済み）と
 *    BullMQ `Worker` を持って queue を listen し始める。
 * 2. 親が `ROUNDS` 回、**小さいバッチ**（`BATCH_SIZE` 件）の Memory + embed ジョブを
 *    outbox へ積み、**直後に** `queue.addBulk` で `BURST_SIZE`（≧ 全ワーカー数）件の
 *    「起爆ジョブ」（中身は空。Worker 側は job の中身を見ず、発火するたびに
 *    `runtime.tick()` を1回呼ぶだけ——`tick-driver.ts` 参照）を**まとめて**積む。
 * 3. `BURST_SIZE` ≧ 全ワーカー数なので、そのラウンドの直後にほぼ全ワーカーが
 *    同時に `claimBatch` を呼びに行く——ADR 0206 の `Promise.all`（同一プロセス内で
 *    8並行）を、複数 OS プロセスへ翻訳した形である。ラウンドあたりの候補行
 *    （`BATCH_SIZE`）はワーカー総数よりずっと少なくしてあり、競合を厚くする。
 * 4. ラウンド間に短い休止（`PER_ROUND_PAUSE_MS`）を置き、最後に排水用の猶予
 *    （`DRAIN_BUFFER_MS`）を置いてから子プロセスを終える。
 *
 * BullMQ の repeat ジョブ（`driver.start()`）自体は今も呼んでいる——ただし
 * `EVERY_MS` を大きく（数秒）取り、**背景の心拍**として動くだけで、重なりを作る
 * 主因はもう「起爆ジョブのまとめ撃ち」である。`EMBED_DELAY_MS` は embed 処理に
 * 現実的な所要時間を持たせる小さな値に留めてある。
 *
 * ## 何を検査し、何を検査しないか（ADR 0206 決定2 と同じ線）
 *
 * - **検査する**: 全プロセスが embed した `Memory.content`（一意な文字列）を集め、
 *   **重複が0件であること**。
 * - ⛔ **検査しない**: 「合計が用意した Memory の本数と一致すること」。ADR 0206 決定2の
 *   「⛔『合計が1本である』ことは検査しない」と同じ理由——`FOR UPDATE SKIP LOCKED`
 *   相当の実装は、競合下で「拾い残す」ことを設計上許容している（拾い残しは次の tick が拾う）。
 *   ここでも同じ許容が働く（`DURATION_MS` を打ち切っても、まだ `pending` のまま
 *   残る Memory があってよい）。
 *
 * ## 変異試験での使い方
 *
 * `packages/postgres/src/outbox-store.ts` を `cp` で退避 → 変異 → この歯を撃つ →
 * `cp` で戻す（AGENTS.md）。子プロセスは相対 import で `packages/postgres/src` を
 * 直接読むため、**ビルドを挟まなくても変異が即座に反映される**
 * （`concurrent-tick-child.ts` 冒頭のコメント参照）。
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

// 子プロセスの実体ファイル（.ts のまま `pnpm exec tsx` へ渡す）。
const CHILD_SCRIPT = fileURLToPath(new URL("./concurrent-tick-child.ts", import.meta.url));
// packages/bullmq のルート(package.json が在る場所) — `pnpm exec` の cwd に使う。
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 子プロセスを1本立て、標準出力から結果行（RESULT_MARKER 付き）を取り出す。 */
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

    // 🔴 これらの定数は変異試験で実測して決めた値である(ADR 0325「測ったこと」
    // の表に試行回数つきで記録してある——2026-09-25 の改訂で「ラウンドを複数回す」
    // 形に変えた経緯・前後の検出率の比較も同じ表にある)。
    const CHILD_COUNT = 4;
    const CONCURRENCY_PER_CHILD = 4;
    const TOTAL_WORKERS = CHILD_COUNT * CONCURRENCY_PER_CHILD; // 16
    // 背景の心拍(BullMQ repeat job)。重なりを作る主因ではないので大きめに取る
    // (上の doc コメント「どうやって『同時』を作るか」2026-09-25 改訂 参照)。
    const EVERY_MS = 3_000;
    const EMBED_DELAY_MS = 30;
    const LEASE_MS = 5 * 60 * 1000;
    // 1回の tick が拾う件数をわざと最小にする(limit=1、ADR 0206 と同じ判断)。
    const TICK_LIMIT = 1;

    // 🔴 ADR 0206「測ったこと3」に倣い、独立したラウンドを複数回す。
    const ROUNDS = 10;
    // ラウンドあたりの候補行は、全ワーカー数よりずっと少なくして競合を厚くする。
    const BATCH_SIZE = 3;
    // 起爆ジョブは全ワーカー数以上——ラウンド直後にほぼ全ワーカーが同時に
    // claimBatch を呼びに行くようにする。
    const BURST_SIZE = TOTAL_WORKERS + 8; // 24
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
          // 'imported' は memories.source_observation_id の NOT NULL 相当の CHECK
          // （0001_init.sql: provenance_kind IN ('stated','inferred') のときだけ必須）
          // に当たらないため、observations 行を用意しなくてよい。
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

    // 子プロセスを先に起動する（自分の接続を温めてから listen し始めるまでに
    // STARTUP_MARGIN_MS だけ余裕を見る）。結果は最後に await する。
    const childResultsPromise = Promise.all(childEnvs.map((env) => runChild(env)));

    // 起爆ジョブ専用の Queue（親プロセス自身が持つ——子プロセスの Worker と
    // 同じ queueName・同じ Redis を指すだけで、ジョブの中身は空でよい。
    // `tick-driver.ts` の Worker は job の中身を見ず、発火のたびに
    // `runtime.tick()` を1回呼ぶだけである）。
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

    // ⭐ 空回り防止（AGENTS.md「⚠『出なかった』を、事象が無いことの証明にしない」）:
    // 少なくとも何か embed された・tick が複数回呼ばれたことを先に見る。
    // 0件のまま「重複も0件でした」は、探り棒が動いていない可能性と区別できない。
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
    // 一意な content の集合を超えて何かを embed していたら、それ自体が別の欠陥
    // （用意していない content を embed した）なので、素通しせず見えるようにする。
    for (const content of allEmbedded) {
      expect(expectedContents).toContain(content);
    }

    // 🔴 本体の検査: 重複0件。
    expect(
      duplicates,
      `同じ Memory が複数プロセスに処理された（二重 embed）: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);

    // ⛔ 合計が用意した本数(ROUNDS*BATCH_SIZE)と一致することは検査しない
    // （ADR 0206 決定2 と同じ理由、上の doc コメント参照）。参考として出力だけする。
    console.log(
      `[concurrent-tick] rounds=${ROUNDS} batchSize=${BATCH_SIZE} memories=${expectedContents.length} ` +
        `embedded(total)=${allEmbedded.length} tickCalls(total)=${totalTickCalls} ` +
        `duplicates=${duplicates.length}`,
    );
  });
  // ↑ ROUNDS(10) × PER_ROUND_PAUSE_MS(400ms) + 起動/排水の余裕 ≈ 8秒 + 子プロセス4本の
  // 起動オーバーヘッド。vitest.redis.config.mts の testTimeout（120秒）の範囲に収める。
});
