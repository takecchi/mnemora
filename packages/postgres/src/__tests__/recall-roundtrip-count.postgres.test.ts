import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 候補の件数に比例して往復数が増えないことを、比の形で固定する歯。
 *
 * 発行される文の数そのもの（例: 7 とか 21 とか）は固定しない。実装の細部（`SET LOCAL` を挟むかどうか等）が変われば動きうる値で、
 * 固定すると「往復が増えたわけではないのに、無関係な変更で赤くなる」歯になるため。
 * だから同じ実装を、候補数（`limit`）だけ変えて2回呼び、往復数を比較する。比較先も同じ実行・同じ環境なので、実装の細部の揺れは両辺に同じだけ乗って相殺される。
 *
 * `VectorStore.searchMany?` が段3.5の全アンカーを1回の往復に束ねるので、`anchorCount` を増やしても往復数は増えない（歯5）。
 * HNSW の近似性の揺れで `returned` の件数（「意味のある比較か」の検算）が不安定にならないよう、データを小さく・決定的に作る。
 *
 * ## 配置（歯1・歯2 共通のデータ形）
 *
 * `recall-association-gates.postgres.test.ts` と同じ三角形の考え方を使う。クエリに直接当たらない `SATELLITE` は、`ANCHOR` を経由した連想枠でしか届かない。
 *
 * - `QUERY = [1,0,0]`
 * - `ANCHOR = [0.70710678,0.70710678,0]`: `cos(QUERY,ANCHOR) ≈ 0.7071`。全候補中最高の類似度にしてあり、`limit` をいくつにしても `withinLimit` の先頭に必ず `ANCHOR` が来る。
 * - `SATELLITE = [0,1,0]`: `cos(QUERY,SATELLITE) = 0`（段2の閾値0.1を割り、通常の候補としては一度も現れない）。
 *   `cos(ANCHOR,SATELLITE) ≈ 0.7071`（連想枠の既定 `minSimilarity` 0.5 を超える）ので、連想枠を通してしか `result.memories` に現れない。
 * - `SECOND = [0.6,0,0.8]`・`THIRD = [0.62,0,-0.7846]`: `cos(QUERY,·)` はそれぞれ 0.6・0.62（`ANCHOR` の 0.7071 未満、`FILLER` の上限 0.30 より上）。
 *   既定の `anchorCount`（3）が選ぶアンカー集合は、`limit` に依存せず常に `{ANCHOR, SECOND, THIRD}` になる。
 *   この2点は互いにも `ANCHOR`/`SATELLITE` にも `cos < 0.5`（連想枠の既定 `minSimilarity` 未満）になるよう Z成分に逃がしてある。アンカーになっても自分の近傍検索が何も拾わない「無害な」アンカーにするため。
 * - `FILLER`: 47件。`ANCHOR`/`SECOND`/`THIRD` のどれとも `cos < 0.5` になる X-Y平面の反対側（Y成分が負）に押し込み、`cos(QUERY,·)` は 0.1（閾値）より大きく 0.30 より小さい範囲に散らす。
 *   `FILLER` どうしは互いに近いが、`ANCHOR`/`SECOND`/`THIRD` が常に `FILLER` 全件より高い類似度を持つので、`FILLER` がアンカーに入ることは無く、この近さが連想枠の結果に影響しない。
 *
 *   ⚠ `SECOND`/`THIRD` を `FILLER` 自身の中から選ぶ形にしない。`FILLER` どうしが密集しているせいで、その近傍検索が類似度 0.999 超の `FILLER` を大量に連想枠へ引き込み、
 *   `SATELLITE`（0.7071）が既定の `maxCount`（10）から押し出されて歯2が落ちる。
 *
 * `ANCHOR` + `SECOND` + `THIRD` + `FILLER`(47件) = 50件が「クエリに直接当たる」候補の全量。`SATELLITE` はそれとは別に、連想枠経由でだけ+1件になる。
 */

const QUERY_VECTOR = [1, 0, 0];
const ANCHOR_VECTOR = [0.70710678, 0.70710678, 0];
const SATELLITE_VECTOR = [0, 1, 0];
const SECOND_VECTOR = [0.6, 0, 0.8];
const THIRD_VECTOR = [0.62, 0, -0.7846];
const FILLER_COUNT = 47;

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("この歯では使わない");
  },
  completeStructured: async () => {
    throw new Error("この歯では使わない");
  },
};

async function buildTestRuntime(space: EmbeddingSpaceId = TEST_EMBEDDING_SPACE) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: {
      claimBatch: async () => [],
      complete: async () => {},
      fail: async () => {},
    },
    vectorStore,
    eventStore: {
      append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
      get: async () => null,
      list: async () => [],
    },
    tenantSettingsStore,
    llmProvider: throwingLlm,
    embeddingProvider: {
      space,
      // `RecallQuery.vector` を直接渡すので embed は呼ばれないはず。
      embed: async () => {
        throw new Error("この歯は RecallQuery.vector を直接渡すので embed を呼ばないはず");
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, memoryStore, vectorStore };
}

async function createEmbeddedMemory(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  vector: number[],
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      embeddingStatus: "ready",
      contentHash: `hash-${randomUUID()}`,
      decayFloorAt: FAR_FUTURE,
      ...overrides,
    }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory;
}

async function seedRoundtripCorpus(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
) {
  const anchor = await createEmbeddedMemory(memoryStore, vectorStore, ctx, ANCHOR_VECTOR, {
    digest: "anchor",
  });
  await createEmbeddedMemory(memoryStore, vectorStore, ctx, SECOND_VECTOR, {
    digest: "second",
  });
  await createEmbeddedMemory(memoryStore, vectorStore, ctx, THIRD_VECTOR, {
    digest: "third",
  });
  for (let i = 1; i <= FILLER_COUNT; i += 1) {
    const cosQuery = 0.3 - i * 0.003;
    const vector = [cosQuery, -Math.sqrt(1 - cosQuery * cosQuery), 0];
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, vector, {
      digest: `filler-${i}`,
    });
  }
  const satellite = await createEmbeddedMemory(memoryStore, vectorStore, ctx, SATELLITE_VECTOR, {
    digest: "satellite",
  });
  return { anchor, satellite };
}

/**
 * 往復数を比較する歯（1・2・4・5）が固定するのは「候補件数・basis件数・anchorCount を変えても往復数が増えない」という比較であって、初回呼び出しに乗る検査ぶんの +1 往復そのものではない。
 * pgvector 能力検査（`PgvectorCapabilityGate`）は `PostgresVectorStore` インスタンスごとに最初の `search()`/`searchMany()` で1往復を足し、
 * `StatsPresenceGate` も `memories`・埋め込み表の両方の統計が確認済みになるまで `search()` のたびに `reltuples` を読む往復を足す。
 * 「未確認→確認済み」に切り替わる回が測定区間に入ると、比較の両辺で往復数が食い違いうるので、測定を始める前に `countClientQueries` の外側で空振りの `search()` を1回打って検査を済ませておく
 * （1回の `search()` が両方の gate を通るので、名前は能力検査のままにしてある。歯6 がこの相乗りを裏取りする）。
 *
 * 歯6 はこの前提をあえて崩し、専用の（他のテストファイルと共有しない、一度も `ANALYZE` されていない）埋め込み表で `StatsPresenceGate` の遷移そのものを測る。
 */
async function warmUpPgvectorCapabilityCheck(
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
): Promise<void> {
  await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
    limit: 1,
    filter: { tenantId: ctx.tenantId },
  });
}

/**
 * 統計が「確認済み」の状態を、測定の前に必ず作る（歯1・2・4・5）。
 *
 * `resetTestDatabase()` の `TRUNCATE` は `reltuples` を `-1`（未確認）へ戻すので、`beforeEach` の後は毎回、両方の表が未確認から始まる。
 * 上の空振りの `search()` は、統計が既に在れば確認済みにするが、統計が無ければ未確認のまま帰るだけである。
 * そのため測定の最中に自動 analyze（autovacuum）が終わると、その1回だけ往復が余分になり、比較の両辺が食い違う。
 *
 * ここで両方の表を `ANALYZE` し、同じ `vectorStore` で `search()` をもう1回打ってゲートを確認済みにする（一度確認済みになったら覚え続ける）。
 * 測定の直前にゲートの状態を決定的にするだけで、歯の主張は弱めていない（許容差も、比べる本数の削減も入れていない）。
 * 種まきの後に呼ぶ（空の表への `ANALYZE` が `reltuples` をどうするかに頼らないため）。歯6 は遷移そのものを測る別の歯（専用の表）なので、これを呼ばない。
 */
async function confirmStatsPresence(vectorStore: PostgresVectorStore, ctx: Ctx): Promise<void> {
  const { pool } = await getTestClient();
  const embeddingTable = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
  await pool.query("ANALYZE memories");
  await pool.query(`ANALYZE ${embeddingTable}`);
  // 事後条件: `ANALYZE` を外すと、`TRUNCATE` 後の `reltuples` は `-1`（未確認）のままで、往復数の比較は「毎回同じ余分な1往復」が乗るだけで等しいまま緑になる。ここで決定的に赤にする。
  const stats = await pool.query(
    "SELECT c.relname, c.reltuples::float8 AS reltuples FROM pg_class c WHERE c.oid = ANY(ARRAY['memories'::regclass, $1::regclass])",
    [embeddingTable],
  );
  expect(stats.rows.map((r) => r.relname).sort()).toEqual(["memories", embeddingTable].sort());
  for (const row of stats.rows) {
    expect(row.reltuples, `${row.relname} の reltuples`).toBeGreaterThanOrEqual(0);
  }
  await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
    limit: 1,
    filter: { tenantId: ctx.tenantId },
  });
  confirmedVectorStores.add(vectorStore);
}

const confirmedVectorStores = new WeakSet<PostgresVectorStore>();

/**
 * 往復数を比較する測定（歯1・2・4・5）の入口。統計を確認済みにしていない `vectorStore` の runtime では測れない。
 * 呼び忘れると、往復数が毎回同じ余分な1往復を払うだけで等しいまま緑になり、「測定の途中で自動 analyze が終わる」赤の芽が戻っても決定的には気付けない。
 * 歯6（未確認→確認済みの遷移そのものを測る）は使わない。
 */
async function countConfirmedQueries(
  vectorStore: PostgresVectorStore,
  fn: () => Promise<unknown>,
): Promise<number> {
  if (!confirmedVectorStores.has(vectorStore)) {
    throw new Error(
      "confirmStatsPresence を呼んでから往復数を測ること（統計が未確認のまま測っている）",
    );
  }
  return countClientQueries(fn);
}

/**
 * `fn` の実行中に発行された pg クエリの本数を数える。`test-db.ts` の `captureClientQuery` と同じ理由で `Client.prototype.query` をパッチする
 * （`pool.query()` も内部で同じ `client.query()` を呼ぶので、1箇所で `db.transaction()` 経由・`pool.query()` 経由のどちらも数えられる）。
 */
async function countClientQueries(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    count += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return count;
}

describe("recall() の往復数は候補の件数に比例しない — 本物の Postgres + pgvector（Postgres クエリ効率監査）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("歯1: 連想枠 off — limit=1 と limit=50 で往復数が等しい（returned は実際に増える）", async () => {
    const ctx: Ctx = { tenantId: `tenant-rtc-ann-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    await warmUpPgvectorCapabilityCheck(vectorStore, ctx);
    await seedRoundtripCorpus(memoryStore, vectorStore, ctx);
    await confirmStatsPresence(vectorStore, ctx);

    let resultSmall: Awaited<ReturnType<typeof runtime.recall>> | undefined;
    let resultLarge: Awaited<ReturnType<typeof runtime.recall>> | undefined;

    const roundtripsSmall = await countConfirmedQueries(vectorStore, async () => {
      resultSmall = await runtime.recall(ctx, {
        vector: QUERY_VECTOR,
        limit: 1,
        channels: ["ann"],
        association: null,
      });
    });
    const roundtripsLarge = await countConfirmedQueries(vectorStore, async () => {
      resultLarge = await runtime.recall(ctx, {
        vector: QUERY_VECTOR,
        limit: 50,
        channels: ["ann"],
        association: null,
      });
    });

    // 無意味な等号にしない: 返る件数は実際に増えている。
    expect(resultSmall!.memories.length).toBe(1);
    expect(resultLarge!.memories.length).toBe(50);

    expect(roundtripsLarge).toBe(roundtripsSmall);
  });

  it("歯2: 既定（連想枠 on、anchorCount は既定のまま）— limit=5/20/50 で往復数が等しい（returned は実際に増える）", async () => {
    const ctx: Ctx = { tenantId: `tenant-rtc-assoc-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    await warmUpPgvectorCapabilityCheck(vectorStore, ctx);
    const { satellite } = await seedRoundtripCorpus(memoryStore, vectorStore, ctx);
    await confirmStatsPresence(vectorStore, ctx);

    const roundtripsByLimit = new Map<number, number>();
    const returnedByLimit = new Map<number, number>();

    for (const limit of [5, 20, 50]) {
      let result: Awaited<ReturnType<typeof runtime.recall>> | undefined;
      const roundtrips = await countConfirmedQueries(vectorStore, async () => {
        // `association` は渡さない。既定のアンカー数（3）のままの経路を測る。
        result = await runtime.recall(ctx, { vector: QUERY_VECTOR, limit, channels: ["ann"] });
      });
      roundtripsByLimit.set(limit, roundtrips);
      returnedByLimit.set(limit, result!.memories.length);
      // SATELLITE は ANCHOR 経由の連想枠でしか届かない——毎回届いていることの検算。
      expect(result!.memories.some((m) => m.memoryId === satellite.id)).toBe(true);
    }

    // 無意味な等号にしない: 返る件数は実際に増えている（limit + SATELLITE の1件）。
    expect(returnedByLimit.get(5)).toBe(6);
    expect(returnedByLimit.get(20)).toBe(21);
    expect(returnedByLimit.get(50)).toBe(51);

    expect(roundtripsByLimit.get(20)).toBe(roundtripsByLimit.get(5));
    expect(roundtripsByLimit.get(50)).toBe(roundtripsByLimit.get(5));
  });

  it("歯3: observe({kind:'memory_usage'}) の往復数は usedMemoryIds の件数に比例しない — N=1/5/20 で等しい（Issue #874、PR「perf/874-reinforce-many」）", async () => {
    // 固定するのは絶対値の式ではなく、歯1・歯2 と同じ相対比較である。
    // この歯が数えるのは `runtime.observe()` 全体（`createObservation` を含む）の往復数で、`createObservation` 側の往復数は対象外なので、
    // 絶対値を固定すると無関係な変更で赤くなる歯になってしまう。
    const ctx: Ctx = { tenantId: `tenant-rtc-usage-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();

    const memoryIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const memory = await createEmbeddedMemory(memoryStore, vectorStore, ctx, ANCHOR_VECTOR, {
        digest: `usage-target-${i}`,
      });
      memoryIds.push(memory.id);
    }

    async function observeMemoryUsage(ids: string[]): Promise<number> {
      // `recall_usages_recall_id_fkey` を満たすため、呼ぶたびに新しい `recalls` 行を1本作る。
      // recall_id が毎回違うので、`memoryIds` を呼び出しの間で再利用しても `recall_usages` の複合PK（tenant_id, recall_id, memory_id）に衝突せず、ON CONFLICT DO NOTHING が効く経路は踏まない。
      const recallId = await memoryStore.createRecall(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        query: { text: "fixture" },
        budget: null,
        omitted: [],
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
      });
      return countClientQueries(async () => {
        const result = await runtime.observe(ctx, {
          kind: "memory_usage",
          recallId,
          usedMemoryIds: ids,
        });
        expect(result.memoryIds.length).toBe(ids.length); // 検算: 全件が新規挿入として強化された。
      });
    }

    const roundtripsN1 = await observeMemoryUsage(memoryIds.slice(0, 1));
    const roundtripsN5 = await observeMemoryUsage(memoryIds.slice(0, 5));
    const roundtripsN20 = await observeMemoryUsage(memoryIds.slice(0, 20));

    expect(roundtripsN5).toBe(roundtripsN1);
    expect(roundtripsN20).toBe(roundtripsN1);
  });

  it("歯4（Issue #883・ADR 0342）: RecalledMemory.basisLost の解決は、inferred が無ければ+0往復、在れば basis の件数に関わらず+1往復のまま増えない", async () => {
    const ctx: Ctx = { tenantId: `tenant-rtc-basislost-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    await warmUpPgvectorCapabilityCheck(vectorStore, ctx);

    // `memories_check`: inferred は source_observation_id が必須（observations への FK）。まず本物の Observation を1件作る。
    async function createInferredMemory(
      vector: number[],
      digest: string,
      basisMemoryIds: string[],
    ) {
      const observation = await memoryStore.createObservation(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        externalId: null,
        kind: "utterance",
        payload: { text: "fixture" },
        occurredAt: null,
      });
      return createEmbeddedMemory(memoryStore, vectorStore, ctx, vector, {
        digest,
        sourceObservationId: observation.id,
        provenance: {
          kind: "inferred",
          model: "test-model",
          promptVersion: "v1",
          basis: { memoryIds: basisMemoryIds, observationIds: [] },
          confidence: 0.9,
        },
      });
    }

    // 基準: inferred を含まない recall。連想枠 off（`association: null`）で、段3の同伴取得も `scope.attributes` も踏まないようにする（候補フェッチ以外の getMany 経路を混ぜない）。
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], { digest: "plain-1" });
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.99, 0.01, 0], {
      digest: "plain-2",
    });
    await confirmStatsPresence(vectorStore, ctx);
    const baselineRoundtrips = await countConfirmedQueries(vectorStore, async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });

    const basis = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, digest: "basis" }),
    );
    await createInferredMemory([0.98, 0.02, 0], "inferred-with-1-basis", [basis.id]);
    const oneBasisRoundtrips = await countConfirmedQueries(vectorStore, async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });
    expect(oneBasisRoundtrips).toBe(baselineRoundtrips + 1);

    // さらに4件の inferred（合計5件）、それぞれ basis 5件を追加する。basis の件数を増やしても往復数が変わらないことを見るのが目的なので、絶対数そのものは固定しない。
    for (let i = 0; i < 4; i += 1) {
      const basisIds: string[] = [basis.id];
      for (let j = 0; j < 5; j += 1) {
        const b = await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, digest: `basis-${i}-${j}` }),
        );
        basisIds.push(b.id);
      }
      await createInferredMemory(
        [0.97 - i * 0.001, 0.03 + i * 0.001, 0],
        `inferred-${i}`,
        basisIds,
      );
    }
    const manyBasisRoundtrips = await countConfirmedQueries(vectorStore, async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });

    expect(manyBasisRoundtrips).toBe(oneBasisRoundtrips);
  });

  it("歯5: 連想枠 on — anchorCount=1/3/10 で往復数が等しい（Issue #377、VectorStore.searchMany? を束ねた後）", async () => {
    // 全50件が段2の閾値(0.1)を超えるので、`limit=20` の `withinLimit` は常に20件。`anchorCount` を 1/3/10 のどれにしても、`withinLimit.slice(0, anchorCount)` は毎回実在する anchorCount 件を返す。
    const ctx: Ctx = { tenantId: `tenant-rtc-anchorcount-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    await warmUpPgvectorCapabilityCheck(vectorStore, ctx);
    await seedRoundtripCorpus(memoryStore, vectorStore, ctx);
    await confirmStatsPresence(vectorStore, ctx);

    const roundtripsByAnchorCount = new Map<number, number>();
    const returnedByAnchorCount = new Map<number, number>();

    for (const anchorCount of [1, 3, 10]) {
      let result: Awaited<ReturnType<typeof runtime.recall>> | undefined;
      const roundtrips = await countConfirmedQueries(vectorStore, async () => {
        result = await runtime.recall(ctx, {
          vector: QUERY_VECTOR,
          limit: 20,
          channels: ["ann"],
          association: { maxCount: 10, anchorCount },
        });
      });
      roundtripsByAnchorCount.set(anchorCount, roundtrips);
      returnedByAnchorCount.set(anchorCount, result!.memories.length);
    }

    // 無意味な等号にしない: anchorCount を変えると連想の探索対象は実際に変わっている。
    // 返る件数そのものはこの corpus では変わらないことがあるので、ここでは「例外にならず、20件以上は必ず返る」ことだけを検算する。
    expect(returnedByAnchorCount.get(1)!).toBeGreaterThanOrEqual(20);
    expect(returnedByAnchorCount.get(3)!).toBeGreaterThanOrEqual(20);
    expect(returnedByAnchorCount.get(10)!).toBeGreaterThanOrEqual(20);

    // anchorCount（1→3→10）を変えても往復数は増えない。`VectorStore.searchMany?` が全アンカーを1回の往復に束ねるため。
    expect(roundtripsByAnchorCount.get(3)).toBe(roundtripsByAnchorCount.get(1));
    expect(roundtripsByAnchorCount.get(10)).toBe(roundtripsByAnchorCount.get(1));
  });

  it("歯6（Issue #1415 / ADR 0374）: recall() の往復数は、統計が未確認の間だけ+1、確認済みになったら今日と同じ数へ戻る", async () => {
    const ctx: Ctx = { tenantId: `tenant-rtc-statsgate-${randomUUID()}` };
    // このテストだけの専用の埋め込み表。一度も ANALYZE していない「統計が無い」表を保証する（`TEST_EMBEDDING_SPACE` は他のテストファイルとも共有するため使わない）。
    const space: EmbeddingSpaceId = {
      provider: "test-issue-1415-roundtrip",
      model: `roundtrip-statsgate-${randomUUID()}`,
      dimensions: 3,
    };
    const { pool } = await getTestClient();
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime(space);

    await createEmbeddedMemory(memoryStore, vectorStore, ctx, ANCHOR_VECTOR, { digest: "one" });
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, SECOND_VECTOR, { digest: "two" });

    const call1 = await countClientQueries(async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });

    // 2回目: pgvector 能力検査は確認済み（インスタンスごとに1回きり）。`StatsPresenceGate` は、表を一度も ANALYZE していないので `reltuples < 0` を観測し続け、まだ未確認のまま。
    const call2 = await countClientQueries(async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });
    expect(
      call2,
      "pgvector 能力検査ぶんの1回だけが消え、StatsPresenceGate ぶんの+1はまだ残るはず",
    ).toBe(call1 - 1);

    await pool.query(`ANALYZE ${table}`);
    await pool.query("ANALYZE memories");

    const call3 = await countClientQueries(async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });
    expect(
      call3,
      "確認済みへ切り替わる、まさにその回はまだ検査ぶんの往復を払うはず（call2 と同数）",
    ).toBe(call2);

    const call4 = await countClientQueries(async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });
    expect(call4, "確認済みになったので、今日と同じ数へ戻るはず").toBe(call3 - 1);

    const call5 = await countClientQueries(async () => {
      await runtime.recall(ctx, { vector: QUERY_VECTOR, channels: ["ann"], association: null });
    });
    expect(call5, "確認済みは以後ずっと保たれ、往復数はこれ以上減らない（増えもしない）").toBe(
      call4,
    );
  });
});
