import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * mnemora の Postgres クエリ効率の実測監査（クローン miku の委譲先が行った作業。
 * オーナーではない）で見つけたことを、比の形で固定する歯。
 *
 * ## 何を固定するか、何を固定しないか
 *
 * **固定するのは「候補の件数に比例して往復数が増えないこと」だけである。**
 * 発行される文の数そのもの（例: 7 とか 21 とか）は、実装の細部（ADR 0284 の
 * `SET LOCAL` を挟むかどうか等）が変われば動きうる値であり、歯として固定すると
 * 「往復が増えたわけではないのに、無関係な変更で赤くなる」歯になってしまう
 * （`docs/north-star.md` 問い3——歯自身が説明できない赤を出さない）。
 * だから**同じ実装を、候補数（`limit`）だけ変えて2回呼び、往復数を比較する**——
 * 比較先も同じ実行・同じ環境なので、実装の細部の揺れは両辺に同じだけ乗って相殺される。
 *
 * **固定しないもの**:
 * - アンカー数（`anchorCount`）ぶんの往復の増加——これは
 *   [Issue #377](https://github.com/takecchi/mnemora/issues/377) の領分であり、
 *   むしろ実測して同 Issue にコメントで実測値を積んである（`9 + 4×anchorCount`）。
 *   本ファイルの歯2 はこの増加を歯には**しない**——`limit` を増やしても
 *   `anchorCount`（既定3）自体は増えないことを利用して、逆に
 *   「アンカー数由来の往復は一定である」ことの土台として使う。
 * - HNSW の近似性そのもの（[Issue #361](https://github.com/takecchi/mnemora/issues/361)）
 *   ——往復数の歯は文の**数**だけを見るので原理的に影響されないはずだが、
 *   `returned` の件数（「意味のある比較か」の検算に使う）が近似索引の揺れで
 *   不安定にならないよう、データを小さく・決定的に作る（下記）。
 *
 * ## 配置（歯1・歯2 共通のデータ形）
 *
 * `recall-association-gates.postgres.test.ts` と同じ三角形の考え方を使う——
 * クエリに直接当たらない `SATELLITE` は、`ANCHOR` を経由した連想枠でしか届かない。
 *
 * - `QUERY = [1,0,0]`
 * - `ANCHOR = [0.70710678,0.70710678,0]` — `cos(QUERY,ANCHOR) ≈ 0.7071`。全候補中
 *   最高の類似度にしてあり、`limit` をいくつにしても `withinLimit` の先頭に必ず
 *   `ANCHOR` が来る。
 * - `SATELLITE = [0,1,0]` — `cos(QUERY,SATELLITE) = 0`（段2の閾値0.1を割り、
 *   通常の候補としては一度も現れない）。`cos(ANCHOR,SATELLITE) ≈ 0.7071`
 *   （連想枠の既定 `minSimilarity` 0.5 を超える）——**連想枠を通してしか
 *   `result.memories` に現れない**。
 * - `SECOND = [0.6,0,0.8]`・`THIRD = [0.62,0,-0.7846]` — `cos(QUERY,·)` は
 *   それぞれ 0.6・0.62（`ANCHOR` の 0.7071 未満、下記 `FILLER` の上限 0.30 より上）。
 *   ⟹ 既定の `anchorCount`（3）が選ぶアンカー集合は、`limit` に依存せず常に
 *   `{ANCHOR, SECOND, THIRD}` になる。**この2点は互いにも `ANCHOR`/`SATELLITE`
 *   にも `cos < 0.5`（連想枠の既定 `minSimilarity` 未満）になるよう Z成分に
 *   逃がしてある**——アンカーになっても自分の近傍検索が何も拾わない「無害な」
 *   アンカーにするため。
 * - `FILLER`: 47件。`ANCHOR`/`SECOND`/`THIRD` のどれとも `cos < 0.5` になる
 *   X-Y平面の反対側（Y成分が負）に押し込み、`cos(QUERY,·)` は 0.1（閾値）より
 *   大きく 0.30（`SECOND`/`THIRD` 未満）より小さい範囲に散らす。`FILLER` どうしは
 *   互いに近い（`cos` が高い）が、`FILLER` が `anchorCount=3` の中に入ることは
 *   無い（`ANCHOR`/`SECOND`/`THIRD` の3つが常に `FILLER` 全件より高い類似度を持つ
 *   ため）ので、この近さが連想枠の結果に影響しない。
 *
 *   ⚠ **最初の設計は `FILLER`（当時「PADDING」）を1本の密な弧に置き、それを
 *   そのまま `anchorCount` の2位・3位にも使っていた**——`SECOND`/`THIRD` に
 *   相当する候補が `FILLER` 自身の中から選ばれてしまい、その近傍検索が
 *   （`FILLER` どうしが密集しているせいで）類似度 0.999 超の `FILLER` を
 *   大量に連想枠へ引き込み、`SATELLITE`（0.7071）が既定の `maxCount`（10）から
 *   押し出されて歯2が落ちた。`SECOND`/`THIRD` を「アンカーになっても近傍検索が
 *   空になる」孤立点として `FILLER` から切り離したのがこの修正である。
 *
 * `ANCHOR` + `SECOND` + `THIRD` + `FILLER`(47件) = 50件が「クエリに直接当たる」
 * 候補の全量。`SATELLITE` はそれとは別に、連想枠経由でだけ+1件になる。
 */

const QUERY_VECTOR = [1, 0, 0];
const ANCHOR_VECTOR = [0.70710678, 0.70710678, 0];
const SATELLITE_VECTOR = [0, 1, 0];
const SECOND_VECTOR = [0.6, 0, 0.8];
const THIRD_VECTOR = [0.62, 0, -0.7846];
const FILLER_COUNT = 47;

const NOW = new Date("2026-01-01T00:00:00.000Z");
/** +100年。壁時計では絶対に沈まない（既存の association gate 歯と同じ定数）。 */
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("この歯では使わない");
  },
  completeStructured: async () => {
    throw new Error("この歯では使わない");
  },
};

async function buildTestRuntime() {
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
      space: TEST_EMBEDDING_SPACE,
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

/**
 * ファイル冒頭の doc コメントが説明する配置（ANCHOR + SECOND + THIRD + FILLER 47件 +
 * SATELLITE）を置く。`FILLER` は X-Y平面の `SATELLITE` とは反対側（Y成分が負）に、
 * `cos(QUERY,·)` が 0.1（閾値）より大きく 0.30（`SECOND`/`THIRD` の下限）より
 * 小さい範囲で散らす——`ANCHOR`/`SECOND`/`THIRD` の3つが常に `FILLER` 全件より
 * 高い類似度を持つので、既定の `anchorCount`（3）が選ぶアンカー集合は
 * `limit` に依存せず常に `{ANCHOR, SECOND, THIRD}` になる（ファイル冒頭の
 * doc コメント参照）。
 */
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
 * `fn` の実行中に発行された pg クエリの本数を数える。
 *
 * `test-db.ts` の `captureClientQuery` と同じ理由で `Client.prototype.query` を
 * パッチする（`pool.query()` も内部で同じ `client.query()` を呼ぶだけなので、
 * ここを1箇所パッチすれば `db.transaction()` 経由・`pool.query()` 経由のどちらも
 * 同じ場所で数えられる）。**このファイルの中だけに閉じた仕組みであり、
 * パッケージの公開 API には出さない。**
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
    await seedRoundtripCorpus(memoryStore, vectorStore, ctx);

    let resultSmall: Awaited<ReturnType<typeof runtime.recall>> | undefined;
    let resultLarge: Awaited<ReturnType<typeof runtime.recall>> | undefined;

    const roundtripsSmall = await countClientQueries(async () => {
      resultSmall = await runtime.recall(ctx, {
        vector: QUERY_VECTOR,
        limit: 1,
        channels: ["ann"],
        association: null,
      });
    });
    const roundtripsLarge = await countClientQueries(async () => {
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

    // 固定するのはこれだけ: 候補の件数（1 → 50）が50倍になっても、往復数は増えない。
    expect(roundtripsLarge).toBe(roundtripsSmall);
  });

  it("歯2: 既定（連想枠 on、anchorCount は既定のまま）— limit=5/20/50 で往復数が等しい（returned は実際に増える）", async () => {
    const ctx: Ctx = { tenantId: `tenant-rtc-assoc-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { satellite } = await seedRoundtripCorpus(memoryStore, vectorStore, ctx);

    const roundtripsByLimit = new Map<number, number>();
    const returnedByLimit = new Map<number, number>();

    for (const limit of [5, 20, 50]) {
      let result: Awaited<ReturnType<typeof runtime.recall>> | undefined;
      const roundtrips = await countClientQueries(async () => {
        // `association` は渡さない — 既定（ADR 0337、DEFAULT_RECALL_ASSOCIATION、
        // anchorCount は DEFAULT_ASSOCIATION_ANCHOR_COUNT=3）のままの経路を測る。
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

    // 固定するのはこれだけ: 候補の件数（limit）を5→20→50と変えても、
    // アンカーの選ばれ方（ANCHOR が常に1位、既定 anchorCount=3）が変わらない限り
    // 往復数は増え続けない。アンカー数ぶんの増加（#377の領分）はここでは固定しない
    // ——固定するのは「候補数を増やしても増えない」ことだけである。
    expect(roundtripsByLimit.get(20)).toBe(roundtripsByLimit.get(5));
    expect(roundtripsByLimit.get(50)).toBe(roundtripsByLimit.get(5));
  });

  it("歯3: observe({kind:'memory_usage'}) の往復数は usedMemoryIds の件数に比例しない — N=1/5/20 で等しい（Issue #874、PR「perf/874-reinforce-many」）", async () => {
    // この歯は元々「recordUsage → reinforce ループは使用報告1件ごとに2往復し、
    // 件数に比例する」ことを `1 + 2 * n` という式で固定していた（現状の記録であり、
    // あるべき姿ではないと明記していた）。[Issue #874](https://github.com/takecchi/mnemora/issues/874)
    // を直した本 PR で、その式のとおり書き換える——ただし固定するのは絶対値の式
    // ではなく、歯1・歯2 と同じ「比較先も同じ実行・同じ環境」の相対比較である
    // （ファイル冒頭の doc コメント参照）。理由: この歯が数えるのは
    // `runtime.observe()` 全体（`createObservation` を含む）の往復数であり、
    // `createObservation` 側の往復数はこの PR の対象外（Issue #870 が並行で
    // `externalId` を足している）——絶対値を固定すると、無関係な変更で赤くなる歯に
    // なってしまう（`docs/north-star.md` 問い3）。
    //
    // 実測値（直す前・直した後とも）は PR 本文に控えてあり、ここには焼き込まない
    // （`AGENTS.md`「数を、道具と生成物に焼き込まない」）——固定するのは、この歯自身が
    // 検査する「N を変えても往復数が変わらない」という関係だけである。
    const ctx: Ctx = { tenantId: `tenant-rtc-usage-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();

    // 使用報告の対象になる Memory を20件、事前に作る（埋め込みは使わないが、
    // 既存の helper をそのまま使う）。
    const memoryIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const memory = await createEmbeddedMemory(memoryStore, vectorStore, ctx, ANCHOR_VECTOR, {
        digest: `usage-target-${i}`,
      });
      memoryIds.push(memory.id);
    }

    async function observeMemoryUsage(ids: string[]): Promise<number> {
      // `recall_usages_recall_id_fkey` を満たすため、呼ぶたびに新しい `recalls` 行を
      // 1本作る（recall_id が毎回違うので、`memoryIds` を呼び出しの間で再利用しても
      // `recall_usages` の複合PK（tenant_id, recall_id, memory_id）に衝突しない
      // ——ON CONFLICT DO NOTHING が効く経路をこの歯では踏まない）。
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

    // 固定するのはこれだけ: usedMemoryIds の件数（1→5→20）が変わっても往復数は増えない。
    expect(roundtripsN5).toBe(roundtripsN1);
    expect(roundtripsN20).toBe(roundtripsN1);
  });
});
