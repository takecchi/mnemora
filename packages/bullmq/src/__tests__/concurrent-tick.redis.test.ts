import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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
 * Issue #205 の2本目（`packages/bullmq`）本体の歯——ADR 0321〔仮番号〕「測ったこと」。
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
 * ## どうやって「同時」を作るか
 *
 * BullMQ の repeat ジョブは、処理時間が間隔（`everyMs`）より長いと、前の実行が
 * 終わる前に次のインスタンスがキューに積まれうる——複数プロセスの Worker が
 * 別々のインスタンスを同時に拾える。`EMBED_DELAY_MS`（fake の `EmbeddingProvider` が
 * 律儀に待つ）を `EVERY_MS` より長くし、この重なりを確実に起こす。
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
  it("N 本の embed ジョブを、K 個の子プロセス（各自の pg.Pool + BullMQ Worker）が同時に tick しても、同じジョブが2プロセス以上に処理されない", async () => {
    const runId = randomUUID();
    const tenantId = `bullmq-concurrency-${runId}`;
    const queueName = `mnemora-bullmq-concurrency-${runId}`;

    // 🔴 これらの定数は変異試験で実測して決めた値である(ADR 0321〔仮番号〕「測ったこと」
    // の表に試行回数つきで記録してある)。⚠ 減らすと ADR 0206「測ったこと3」と同型の
    // 見逃しが起きる——`packages/postgres/src/outbox-store.ts` の `FOR UPDATE SKIP LOCKED`
    // を丸ごと削る変異を入れても、偶然赤くならない試行が混ざる。**この歯は確率的である**
    // ——本 PR の実測では最終パラメータでも 8 試行中 7 回の検出に留まる(100% ではない)。
    // 見逃しても複数回撃てば拾える、という前提で読むこと。
    const MEMORY_COUNT = 80;
    const CHILD_COUNT = 4;
    const CONCURRENCY_PER_CHILD = 4;
    const EVERY_MS = 10;
    const EMBED_DELAY_MS = 200;
    const DURATION_MS = 7_000;
    const LEASE_MS = 5 * 60 * 1000;
    // 🔴 1回の tick が拾う件数をわざと最小にする(limit=1)——MEMORY_COUNT を大きくしても
    // limit が大きいと最初の数ラウンドで全件が捌けてしまい、「競争の窓」が
    // 接続の温まっていない最初期だけに圧縮される(ADR 0206「案F」の実測と同じ形。
    // ADR 0206 自身も同時 claim の歯を `limit: 1` で書いている)。
    const TICK_LIMIT = 1;

    // このテナント専用の一意な content を N 本用意する（重複検査のキー）。
    const memoryStore = new PostgresMemoryStore(client.db);
    const expectedContents: string[] = [];
    for (let i = 0; i < MEMORY_COUNT; i += 1) {
      const content = `bullmq-concurrency-${runId}-${i}`;
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
        provenance: { kind: "imported", batchId: "bullmq-concurrency-test" },
        tags: [],
        recordedAt: new Date(),
        strength: 1,
        halfLifeHours: 24,
        decayFloorAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        embeddingStatus: "pending",
      };
      const { created } = await memoryStore.createMemoryWithOutbox({ tenantId }, input, ["embed"]);
      expect(created).toBe(true);
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

    const results = await Promise.all(childEnvs.map((env) => runChild(env)));

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

    // ⛔ 合計が MEMORY_COUNT と一致することは検査しない（ADR 0206 決定2 と同じ理由、
    // 上の doc コメント参照）。参考として出力だけしておく。
    console.log(
      `[concurrent-tick] memories=${MEMORY_COUNT} embedded(total)=${allEmbedded.length} ` +
        `tickCalls(total)=${totalTickCalls} duplicates=${duplicates.length}`,
    );
  });
  // ↑ 6秒 × 4子プロセスの起動オーバーヘッドを見込む。vitest.redis.config.mts の
  // testTimeout（120秒）の範囲に収める。
});
