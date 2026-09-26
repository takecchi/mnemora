import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import {
  diffBackends,
  type FuzzBackend,
  type FuzzProfile,
  fuzzSeeds,
  genOps,
} from "../../../core/src/__tests__/recall-invariant-fuzz-harness.js";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * recall の不変条件の検査器（`packages/core/src/__tests__/recall-invariant-fuzz-harness.ts`。
 * I1〜I12 の一覧と約束の在り処もそこに在る）を、本物の Postgres + pgvector の store 一式で回す。
 * Fake とは違う経路（SQL・索引・`aggregateScope`・HNSW）を通すのが目的。
 *
 * - ベクトルは2次元の操作列の3次元目を 0 で埋めて `TEST_EMBEDDING_SPACE`（3次元）へ写す
 *   （コサインは変わらない）。
 * - I9（決定性）は当てない。Postgres の id は `gen_random_uuid()` で振られ、同点の並びの
 *   決着は id で付くので、同じ操作列でも実行ごとに並びが変わりうる——それは約束の外である
 *   （【実測】同じ40シードを2回流すと、`filtered: archived` の合計が 109 と 118 に分かれた。
 *   同点の並びが使用報告の対象を変え、強化・減衰・アーカイブへ波及する）。
 *
 * 脚は3つ。接続の設定（`options`）だけを変え、SQL も結果の約束も変えない。
 * - `default`: Fake と同じ操作列を、プランナ任せの接続で。1シードの記憶は高々二十数件で、
 *   【実測】EXPLAIN では段1は HNSW を使わない（ゲートの索引と pkey を選ぶ）。
 * - `wide`: `bulk` で数十〜数百件を作り窓を広げた操作列を、`enable_seqscan = off` の接続で。
 *   【実測】EXPLAIN で段1が `idx_memory_embeddings_hnsw_*` の Index Scan になる——近似索引の
 *   経路（`hnsw.iterative_scan = relaxed_order`、ADR 0284）を通す。
 * - 差分: 同じ操作列を Fake と Postgres に流し、recall ごとの結果を突き合わせる（`diffBackends`）。
 *   Postgres 側は `enable_indexscan = off` の接続で回す——HNSW は索引スキャンしか持たないので
 *   使われず、段1は厳密になる。**HNSW を通す脚には差分を当てない**:【実測】`wide` の20シードを
 *   `enable_seqscan = off` で突き合わせると17シードで食い違い、どれも `lexical_truncated` か
 *   `ann_unreached`（窓が満杯でも近似索引は真の上位を取りこぼしうる、ADR 0193）の立った recall
 *   だった——約束の内の揺れで、そこで打ち切ると突き合わせる recall がほとんど残らない。
 */

const LEN = Number(process.env.RECALL_FUZZ_LEN ?? 60);
const DEFAULT_SEEDS = Number(process.env.RECALL_FUZZ_PG_SEEDS ?? 40);
const WIDE_SEEDS = Number(process.env.RECALL_FUZZ_PG_WIDE_SEEDS ?? 10);
const DIFF_SEEDS = Number(process.env.RECALL_FUZZ_PG_DIFF_SEEDS ?? 40);
const FIRST_SEED = Number(process.env.RECALL_FUZZ_PG_FIRST_SEED ?? 1);

type ConnectionMode = "planner" | "seqscan_off" | "indexscan_off";

const CONNECTION_OPTIONS: Record<Exclude<ConnectionMode, "planner">, string> = {
  seqscan_off: "-c enable_seqscan=off",
  indexscan_off: "-c enable_indexscan=off",
};

const extraClients = new Map<ConnectionMode, PostgresClient>();

async function getClient(mode: ConnectionMode): Promise<PostgresClient> {
  const shared = await getTestClient(); // マイグレーションと埋め込み空間の登録もここで済む
  if (mode === "planner") return shared;
  let client = extraClients.get(mode);
  if (!client) {
    client = createPostgresClient(requireDatabaseUrl(), { options: CONNECTION_OPTIONS[mode] });
    extraClients.set(mode, client);
  }
  return client;
}

function postgresBackend(mode: ConnectionMode): FuzzBackend {
  return {
    async setup() {
      await resetTestDatabase();
      const { db } = await getClient(mode);
      return {
        stores: {
          memoryStore: new PostgresMemoryStore(db),
          outboxStore: new PostgresOutboxStore(db),
          vectorStore: new PostgresVectorStore(db),
          lexicalStore: new PostgresLexicalStore(db),
          eventStore: new PostgresEventStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
          embeddingProvider: {
            space: TEST_EMBEDDING_SPACE,
            embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
          },
        },
        createRuntime,
      };
    },
    vector: (v) => [...v, 0],
  };
}

/** 差分の相手。id は正規化で作成順の別名に置き換えるので、モジュールを読み直す必要は無い。 */
const fakeBackend: FuzzBackend = {
  setup: async () => ({ stores: createFakeRuntimeStores(), createRuntime }),
  vector: (v) => [...v],
};

const INVARIANT_LEGS: { profile: FuzzProfile; seeds: number; mode: ConnectionMode }[] = [
  { profile: "default", seeds: DEFAULT_SEEDS, mode: "planner" },
  { profile: "wide", seeds: WIDE_SEEDS, mode: "seqscan_off" },
];

describe("recall の不変条件（シードつきのランダムな操作列、本物の Postgres + pgvector）", () => {
  afterAll(async () => {
    for (const client of extraClients.values()) await client.pool.end();
    extraClients.clear();
    await closeTestClient();
  });

  for (const leg of INVARIANT_LEGS) {
    it(`${leg.profile}（${leg.mode}）: ${leg.seeds} シード × ${LEN} 操作で、I1〜I8・I10〜I12 の違反が無い`, async () => {
      const report = await fuzzSeeds(postgresBackend(leg.mode), {
        seeds: leg.seeds,
        len: LEN,
        checkDeterminism: false,
        firstSeed: FIRST_SEED,
        profile: leg.profile,
      });
      expect(report).toBe("");
    }, 1_800_000);
  }

  it(`差分（indexscan_off）: ${DIFF_SEEDS} シード × ${LEN} 操作で、Fake と recall の結果が食い違わない`, async () => {
    const reports: string[] = [];
    let compared = 0;
    for (let seed = FIRST_SEED; seed < FIRST_SEED + DIFF_SEEDS; seed++) {
      const outcome = await diffBackends(
        fakeBackend,
        postgresBackend("indexscan_off"),
        genOps(seed, LEN),
        seed,
      );
      compared += outcome.compared;
      if (outcome.diff) {
        reports.push(
          [
            `seed=${seed} recall #${outcome.diff.recall} の ${outcome.diff.path} が食い違った`,
            `  Fake:     ${outcome.diff.a}`,
            `  Postgres: ${outcome.diff.b}`,
          ].join("\n"),
        );
      }
    }
    expect(reports.join("\n\n")).toBe("");
    // 打ち切り（`lexical_truncated`）だけで空振りしていないこと。
    expect(compared).toBeGreaterThan(0);
  }, 1_800_000);
});
