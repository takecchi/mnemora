import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryRelationStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import {
  breakTotalInScope,
  diffRuns,
  type FuzzBackend,
  type FuzzProfile,
  type FuzzStores,
  fuzzSeeds,
  genOps,
  type Op,
  runForDiff,
  type RunOutcome,
} from "../../../core/src/__tests__/recall-invariant-fuzz-harness.js";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresRelationStore } from "../relation-store.js";
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
 * - 差分: 同じ操作列を Fake・testkit の `InMemory*` と Postgres に流し、recall ごとの結果を突き合わせる
 *   （`diffRuns`）。Postgres の側は seed ごとに1回だけ流し、その結果を Fake・testkit・陽性対照で使い回す。
 *   陽性対照は、testkit の側の `aggregateScope` を壊す（`totalInScope` を1だけ多く返す）と食い違いが
 *   報告されること——検査器が黙って何も比べなくなる回帰を捕まえる。
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
// ADR 0492: これまで一度も振っていなかった recall の欄（`timeWeighting`・`digestBandLimit`・クエリの `tags`・
// create の `occurredAt`）を振る profile。CI の所要時間を延ばさないよう、本数は小さく絞る。
const FIELDS_SEEDS = Number(process.env.RECALL_FUZZ_PG_FIELDS_SEEDS ?? 10);
const FIELDS_DIFF_SEEDS = Number(process.env.RECALL_FUZZ_PG_FIELDS_DIFF_SEEDS ?? 10);
// ADR 0494: `relationStore` をつなぐ profile（`relations`）と、引数を変形する profile（`argdead`・`argupper`）。
const RELATIONS_SEEDS = Number(process.env.RECALL_FUZZ_PG_RELATIONS_SEEDS ?? 10);
const RELATIONS_DIFF_SEEDS = Number(process.env.RECALL_FUZZ_PG_RELATIONS_DIFF_SEEDS ?? 10);
const ARG_SEEDS = Number(process.env.RECALL_FUZZ_PG_ARG_SEEDS ?? 10);
const ARGDEAD_DIFF_SEEDS = Number(process.env.RECALL_FUZZ_PG_ARGDEAD_DIFF_SEEDS ?? 10);
// ADR 0521: fixture が大文字の対象 id を Postgres と同じに受けるようになったので、`argupper` も差分に載せる。
const ARGUPPER_DIFF_SEEDS = Number(process.env.RECALL_FUZZ_PG_ARGUPPER_DIFF_SEEDS ?? 10);
// ADR 0509: `channels`（`ann`／`lexical` の組）を振る profile（tsvector の store と trigram の store で別々に）、
// `fields` の欄を HNSW の経路（`seqscan_off`）に載せる脚 `fieldswide`（`wide` と同じ規模）。小さい `fields` は `seqscan_off` でも HNSW を通らない（ADR 0509 の EXPLAIN）。
const CHANNELS_SEEDS = Number(process.env.RECALL_FUZZ_PG_CHANNELS_SEEDS ?? 10);
const CHANNELS_DIFF_SEEDS = Number(process.env.RECALL_FUZZ_PG_CHANNELS_DIFF_SEEDS ?? 10);
// `fieldswide` は記憶が数十〜数百件になる（`wide` と同じ規模）ので、本数を半分にする。
const FIELDS_WIDE_SEEDS = Number(process.env.RECALL_FUZZ_PG_FIELDS_WIDE_SEEDS ?? 5);
const POSITIVE_CONTROL_SEEDS = 5;
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

function postgresBackend(
  mode: ConnectionMode,
  lexical: "tsvector" | "trigram" = "tsvector",
): FuzzBackend {
  return {
    async setup() {
      await resetTestDatabase();
      const { db } = await getClient(mode);
      // trigram の store は `create` が `pg_trgm` の前提を確かめて SQL 関数を入れる（ADR 0319）。
      const lexicalStore =
        lexical === "trigram"
          ? await PostgresTrigramLexicalStore.create(db)
          : new PostgresLexicalStore(db);
      return {
        stores: {
          memoryStore: new PostgresMemoryStore(db),
          outboxStore: new PostgresOutboxStore(db),
          vectorStore: new PostgresVectorStore(db),
          lexicalStore,
          eventStore: new PostgresEventStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
          relationStore: new PostgresRelationStore(db),
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

/**
 * `@mnemora/testkit/fixtures` の `InMemory*`。外部の adapter の作り手が比べる相手として出荷される
 * fixture なので、Postgres との食い違いを core の Fake とは別に見る。`wrap` は陽性対照用。
 */
function testkitBackend(
  wrap: (store: FuzzStores["memoryStore"]) => FuzzStores["memoryStore"] = (store) => store,
): FuzzBackend {
  return {
    async setup() {
      const memoryStore = new InMemoryMemoryStore();
      return {
        stores: {
          memoryStore: wrap(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          vectorStore: new InMemoryVectorStore(memoryStore),
          lexicalStore: new InMemoryLexicalStore(memoryStore),
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          tenantSettingsStore: new InMemoryTenantSettingsStore(),
          relationStore: new InMemoryRelationStore(memoryStore, memoryStore.relations),
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

// Postgres の側の実行結果は seed が同じなら同じなので、差分の it どうしで使い回す
// （Postgres を seed ごとに1回しか流さない）。
const postgresRuns = new Map<string, RunOutcome>();
async function postgresRun(seed: number, profile: FuzzProfile = "default"): Promise<RunOutcome> {
  const key = `${profile}:${seed}`;
  let run = postgresRuns.get(key);
  if (!run) {
    run = await runForDiff(
      postgresBackend("indexscan_off"),
      genOps(seed, LEN, profile),
      seed,
      profile === "relations",
    );
    postgresRuns.set(key, run);
  }
  return run;
}

/** `other` と Postgres を `seeds` 本突き合わせ、食い違いの報告（無ければ空文字列）と突き合わせた recall の数を返す。 */
async function diffAgainstPostgres(
  name: string,
  other: FuzzBackend,
  seeds: number,
  profile: FuzzProfile = "default",
): Promise<{ report: string; compared: number }> {
  const reports: string[] = [];
  let compared = 0;
  for (let seed = FIRST_SEED; seed < FIRST_SEED + seeds; seed++) {
    const outcome = diffRuns(
      await runForDiff(other, genOps(seed, LEN, profile), seed, profile === "relations"),
      await postgresRun(seed, profile),
    );
    compared += outcome.compared;
    if (outcome.diff) {
      reports.push(
        [
          `seed=${seed}${profile === "default" ? "" : `（${profile}）`} recall #${outcome.diff.recall} の ${outcome.diff.path} が食い違った`,
          `  ${name}: ${outcome.diff.a}`,
          `  Postgres: ${outcome.diff.b}`,
        ].join("\n"),
      );
    }
  }
  return { report: reports.join("\n\n"), compared };
}

const INVARIANT_LEGS: {
  profile: FuzzProfile;
  seeds: number;
  mode: ConnectionMode;
  lexical?: "trigram";
}[] = [
  { profile: "default", seeds: DEFAULT_SEEDS, mode: "planner" },
  { profile: "wide", seeds: WIDE_SEEDS, mode: "seqscan_off" },
  { profile: "fields", seeds: FIELDS_SEEDS, mode: "planner" },
  { profile: "relations", seeds: RELATIONS_SEEDS, mode: "planner" },
  { profile: "argdead", seeds: ARG_SEEDS, mode: "planner" },
  { profile: "argupper", seeds: ARG_SEEDS, mode: "planner" },
  { profile: "channels", seeds: CHANNELS_SEEDS, mode: "planner" },
  { profile: "channels", seeds: CHANNELS_SEEDS, mode: "planner", lexical: "trigram" },
  { profile: "fieldswide", seeds: FIELDS_WIDE_SEEDS, mode: "seqscan_off" },
];

describe("recall の不変条件（シードつきのランダムな操作列、本物の Postgres + pgvector）", () => {
  afterAll(async () => {
    for (const client of extraClients.values()) await client.pool.end();
    extraClients.clear();
    await closeTestClient();
  });

  for (const leg of INVARIANT_LEGS) {
    it(`${leg.profile}（${leg.mode}${leg.lexical ? `、${leg.lexical}` : ""}）: ${leg.seeds} シード × ${LEN} 操作で、I1〜I8・I10〜I12・I16 の違反が無い`, async (context) => {
      // trigram の store は UTF8 の `server_encoding` を前提とする（ADR 0103・0319。`create` が
      // `server_encoding_not_utf8` で断るのは仕様）。満たさない環境（CI の SQL_ASCII の job）では
      // この脚だけ skip する（skip は vitest の出力に残る）。UTF8 の job が同じ脚を走らせる。
      if (leg.lexical === "trigram") {
        const { db } = await getClient(leg.mode);
        const probe = await probeTrigramLexicalSupport(db);
        if (!probe.ok) context.skip();
      }
      const report = await fuzzSeeds(postgresBackend(leg.mode, leg.lexical), {
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
    const { report, compared } = await diffAgainstPostgres("Fake", fakeBackend, DIFF_SEEDS);
    expect(report).toBe("");
    // 打ち切り（`lexical_truncated`）だけで空振りしていないこと。
    expect(compared).toBeGreaterThan(0);
  }, 1_800_000);

  it(`差分（indexscan_off）: ${DIFF_SEEDS} シード × ${LEN} 操作で、testkit の InMemory と recall の結果が食い違わない`, async () => {
    const { report, compared } = await diffAgainstPostgres("testkit", testkitBackend(), DIFF_SEEDS);
    expect(report).toBe("");
    expect(compared).toBeGreaterThan(0);
  }, 1_800_000);

  it(`差分（fields、indexscan_off）: ${FIELDS_DIFF_SEEDS} シード × ${LEN} 操作で、Fake と recall の結果が食い違わない`, async () => {
    const { report, compared } = await diffAgainstPostgres(
      "Fake",
      fakeBackend,
      FIELDS_DIFF_SEEDS,
      "fields",
    );
    expect(report).toBe("");
    expect(compared).toBeGreaterThan(0);
  }, 1_800_000);

  it(`差分（fields、indexscan_off）: ${FIELDS_DIFF_SEEDS} シード × ${LEN} 操作で、testkit の InMemory と recall の結果が食い違わない`, async () => {
    const { report, compared } = await diffAgainstPostgres(
      "testkit",
      testkitBackend(),
      FIELDS_DIFF_SEEDS,
      "fields",
    );
    expect(report).toBe("");
    expect(compared).toBeGreaterThan(0);
  }, 1_800_000);

  for (const [profile, seeds] of [
    ["relations", RELATIONS_DIFF_SEEDS],
    ["argdead", ARGDEAD_DIFF_SEEDS],
    ["argupper", ARGUPPER_DIFF_SEEDS],
    ["channels", CHANNELS_DIFF_SEEDS],
  ] as const) {
    it(`差分（${profile}、indexscan_off）: ${seeds} シード × ${LEN} 操作で、Fake・testkit の InMemory と recall の結果が食い違わない`, async () => {
      for (const [name, backend] of [
        ["Fake", fakeBackend],
        ["testkit", testkitBackend()],
      ] as const) {
        const { report, compared } = await diffAgainstPostgres(name, backend, seeds, profile);
        expect(report).toBe("");
        expect(compared).toBeGreaterThan(0);
      }
    }, 1_800_000);
  }

  // ADR 0509「割れ」→ ADR 0513 で fixture を Postgres に揃えた: `channels` を振って見つかった語彙検索の食い違い 2 つを、
  // 固定の操作列で「食い違わない」ことを留める（ADR 0509 の時点では「いまは食い違う」を留めていた）。
  // どちらも `CHANNEL_WORDS` に戻してある（`alp`・`PROJ-12`）ので、`channels` の脚も同じ語を踏む。
  const lexicalOps = (word: string, text: string): Op[] => [
    { k: "create", v: 0, tags: [], ready: true, zero: false, subj: false, hl: 24, w: word },
    {
      k: "recall",
      v: 0,
      limit: 3,
      off: 2,
      assoc: 0,
      budget: 0,
      thr: -1,
      lex: false,
      ch: { c: ["lexical"], text },
    },
  ];
  const pinnedDiff = async (backend: FuzzBackend, ops: Op[]) =>
    diffRuns(
      await runForDiff(backend, ops, 1),
      await runForDiff(postgresBackend("indexscan_off"), ops, 1),
    ).diff;

  it("ADR 0509 の割れ 1（ADR 0513 で解消）: query の語 `a` は content `alpha` に当たらない（Postgres は語（token）一致）。Fake・testkit とも Postgres と食い違わない", async () => {
    const ops = lexicalOps("alpha", "a");
    expect(await pinnedDiff(fakeBackend, ops)).toBeNull();
    expect(await pinnedDiff(testkitBackend(), ops)).toBeNull();
  }, 1_800_000);

  it("ADR 0509 の割れ 2（ADR 0513 で解消）: `PROJ-12` は空白区切りの 1 語で、coverage の分母は 2（`gamma` と `PROJ-12`）。Fake・testkit とも Postgres と食い違わない", async () => {
    const ops = lexicalOps("gamma", "gamma PROJ-12");
    expect(await pinnedDiff(testkitBackend(), ops)).toBeNull();
    expect(await pinnedDiff(fakeBackend, ops)).toBeNull();
  }, 1_800_000);

  it("陽性対照: testkit の InMemory の aggregateScope を壊すと、食い違いが報告される", async () => {
    // 食い違いが1つ見えれば足りるので、本数は絞る。
    const { report } = await diffAgainstPostgres(
      "testkit（壊した）",
      testkitBackend(breakTotalInScope),
      POSITIVE_CONTROL_SEEDS,
    );
    expect(report).toMatch(/totalInScope/);
  }, 1_800_000);
});
