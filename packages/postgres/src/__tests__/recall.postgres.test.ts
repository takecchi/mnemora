import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, LLMProvider, MemoryStatus } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
  seededRandom,
} from "./test-db.js";

/**
 * roadmap.md 段階4「想起」・段階5「説明」の完了条件を、擬似物ではなく本物の
 * Postgres + pgvector に対して検査する（PR 本文「守る線」: 擬似物のほうが本物より
 * 偶然厳しいことがある、必ず本物に通す）。
 *
 * ここで検査すること:
 * - 段1の ANN クエリが実際に HNSW 索引を使うこと（`runtime.recall()` の実行経路そのものを
 *   EXPLAIN する。`vector-search-hnsw.test.ts` は `PostgresVectorStore.search` 単体を
 *   検査しているが、ここでは recall() 全体の配線が同じクエリ形を保っていることを確認する）。
 * - 被覆不変条件（groups の総和 == totalInScope）が、単一クエリ由来であること
 *   （構造的な検査: aggregateScope が1回の SQL 往復で完結すること）と、
 *   並行して書き込みが起きている最中でも成立すること。
 * - omitted の各 kind が実データに対して実際に発生すること。
 */

const TENANT = "recall-pg-tenant";
const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used by recall tests");
  },
  completeStructured: async () => {
    throw new Error("not used by recall tests");
  },
};

function makeEmbeddingProvider(opts: { shouldFail?: boolean } = {}): EmbeddingProvider {
  return {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx, texts) => {
      if (opts.shouldFail) {
        throw new Error("simulated embedding provider failure");
      }
      return texts.map(() => [1, 0, 0]);
    },
  };
}

async function buildTestRuntime(opts: { embeddingShouldFail?: boolean } = {}) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const runtime = createRuntime({
    memoryStore,
    // observe()/tick() 関連の依存は recall のテストでは使わないため、ダミーで埋める。
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
    tenantSettingsStore: { getDefaultHalfLifeHours: async () => 720 },
    llmProvider: throwingLlm,
    embeddingProvider: makeEmbeddingProvider({ shouldFail: opts.embeddingShouldFail }),
    hashContent: (content: string) => `sha256(${content})`,
    // buildNewMemoryFixture の既定 recordedAt（2026-01-01）に固定する。
    // 実時計（systemClock）のままだと、既定の halfLifeHours（720h=30日、
    // buildNewMemoryFixture の既定値）に対して経過時間が何倍にもなり、
    // decay で score.total がほぼ0まで落ちて below_threshold に化けてしまう
    // （実際にこの食い違いで検査が赤くなった。テスト設計上の固定であり、
    // recall() 本体の挙動には影響しない）。
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
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
    buildNewMemoryFixture({ tenantId: ctx.tenantId, embeddingStatus: "ready", ...overrides }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory;
}

describe("runtime.recall() — 本物の Postgres + pgvector（roadmap.md 段階4/5）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("段1の ANN クエリは EXPLAIN で HNSW 索引を使う（recall() 全体の実行経路として）", async () => {
    const { pool } = await getTestClient();
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };
    const rand = seededRandom(20260905);

    for (let i = 0; i < 3000; i += 1) {
      await createEmbeddedMemory(memoryStore, vectorStore, ctx, [rand(), rand(), rand()]);
    }
    await pool.query(`ANALYZE ${TABLE}`);
    await pool.query("ANALYZE memories");

    let capturedText: string | undefined;
    let capturedParams: unknown[] | undefined;
    const originalQuery = pool.query.bind(pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      const [config, params] = args as [string | { text: string }, unknown[] | undefined];
      const text = typeof config === "string" ? config : config.text;
      if (text.includes(TABLE) && /order by/i.test(text)) {
        capturedText = text;
        capturedParams = params;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any)(...args);
    };

    try {
      await runtime.recall(ctx, { vector: [0.5, 0.5, 0.5], limit: 10 });
    } finally {
      pool.query = originalQuery;
    }

    expect(capturedText).toBeDefined();
    const explainResult = await pool.query(`EXPLAIN (FORMAT TEXT) ${capturedText}`, capturedParams);
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 60_000);

  it("status ゲートは段1と同じ status IN ('active','contested')", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };
    const excluded: MemoryStatus[] = ["superseded", "archived", "forgotten"];
    for (const status of excluded) {
      await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], { status });
    }
    const included = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      status: "active",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toEqual([included.id]);
  });

  it("omitted: stage_skipped(empty_query_content) / stage_skipped(embedding_provider_unavailable)", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { runtime: runtimeNoQuery } = await buildTestRuntime();
    const noQuery = await runtimeNoQuery.recall(ctx, {});
    expect(noQuery.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "empty_query_content",
    });

    const { runtime: runtimeFailingEmbed } = await buildTestRuntime({ embeddingShouldFail: true });
    const failedEmbed = await runtimeFailingEmbed.recall(ctx, { text: "hello" });
    expect(failedEmbed.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "embedding_provider_unavailable",
    });
  });

  it("omitted: filtered(archived) / filtered(superseded) / filtered(forgotten) / filtered(period) / not_indexed", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // in-scope(active/contested かつ period 内)を2件(どちらも ready)にしておく。
    // not_indexed の FILTER 条件が壊れて逆転しても(例: <> と = を取り違えても)
    // in-scope の ready/pending が 1:1 のままだと件数が偶然一致してしまい、
    // 検査として機能しない(実際にこの対称性で1度赤くならなかった。歯の規律の実例)。
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], { status: "active" });
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.9, 0.1, 0], { status: "active" });
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "archived" }),
    );
    // superseded と forgotten を非対称の件数にする（ADR 0027、2件と1件）。
    // 1件ずつだと、取り違え（superseded/forgotten を入れ替えて数える）も
    // 束ねたまま（両方を1つの filtered omission に合算する）も見抜けない。
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "superseded" }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "superseded" }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "forgotten" }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        occurredAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, embeddingStatus: "pending" }),
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      occurredAfter: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "archived",
      count: 1,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "superseded",
      count: 2,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      count: 1,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "period",
      count: 1,
      countKind: "exact",
    });
    // not_indexed(pending) の1件 + occurredAt が古い1件のうち、pending の1件だけが not_indexed。
    expect(result.omitted).toContainEqual({
      kind: "not_indexed",
      reason: "pending",
      count: 1,
      countKind: "exact",
    });
  });

  it("omitted: below_threshold（閾値未満）", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // 直交ベクトル -> similarity=0 -> total=0 (< 既定閾値0.1) -> below_threshold
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0, 1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    expect(result.memories).toHaveLength(0);
    const omission = result.omitted.find((o) => o.kind === "below_threshold");
    expect(omission).toBeDefined();
  });

  it("omitted: over_limit と ann_truncated が同時に発生しうる", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // クエリに近い候補を4件用意する。limit=1, overFetchFactor=3 -> k'=3。
    // ANN は4件中3件しか返さない(ann_truncated) が、返った3件はいずれも閾値を超えるため
    // limit=1 を超えた2件が over_limit になる。
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0]);
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.99, 0.01, 0]);
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.98, 0.02, 0]);
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.97, 0.03, 0]);

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      overFetchFactor: 3,
    });

    expect(result.memories).toHaveLength(1);
    expect(result.omitted).toContainEqual({ kind: "over_limit", count: 2, countKind: "exact" });
    expect(result.omitted).toContainEqual({ kind: "ann_truncated", countKind: "unknown" });
  });

  it("段3/段4: 矛盾の同伴取得は予算に収まらなければペアごと落とす", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "contested", digest: "B".repeat(30) }),
    );
    const a = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      status: "contested",
      contestedWithId: b.id,
      digest: "A".repeat(5),
    });

    const withoutBudget = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const withoutBudgetIds = withoutBudget.memories.map((m) => m.memoryId);
    expect(withoutBudgetIds).toContain(a.id);
    expect(withoutBudgetIds).toContain(b.id);
    const companion = withoutBudget.memories.find((m) => m.memoryId === b.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
    expect(companion?.companionOf).toBe(a.id);
    const indexA = withoutBudgetIds.indexOf(a.id);
    const indexB = withoutBudgetIds.indexOf(b.id);
    expect(Math.abs(indexA - indexB)).toBe(1);

    const withTightBudget = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      budget: { maxMemoryChars: 10 },
    });
    const tightIds = withTightBudget.memories.map((m) => m.memoryId);
    expect(tightIds).not.toContain(a.id);
    expect(tightIds).not.toContain(b.id);
    expect(withTightBudget.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 2,
      countKind: "exact",
    });
  });

  it("段6: recallId が発行され、observe({kind:'memory_usage'}) から参照できる", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };
    const memory = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    expect(result.recallId).toBeTruthy();

    const usageResult = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: result.recallId,
      usedMemoryIds: [memory.id],
    });
    expect(usageResult.memoryIds).toEqual([memory.id]);
  });

  it("被覆不変条件: aggregateScope は単一の SQL 往復で完結する（構造的な検査）", async () => {
    const { pool } = await getTestClient();
    const { memoryStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT }));
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "archived" }),
    );

    let queryCount = 0;
    const originalQuery = pool.query.bind(pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      const [config] = args as [string | { text: string }];
      const text = typeof config === "string" ? config : config.text;
      if (text.includes("FROM memories")) {
        queryCount += 1;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any)(...args);
    };

    try {
      await memoryStore.aggregateScope(ctx, {});
    } finally {
      pool.query = originalQuery;
    }

    // この歯は「群カウントと totalInScope を別クエリにした」瞬間に赤くなるはずである
    // （ADR 0011 と同じ理由。PR 本文参照）。
    expect(queryCount).toBe(1);
  });

  it("被覆不変条件: 並行して書き込みが起きている最中でも groups の総和 == totalInScope が崩れない", async () => {
    const { memoryStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    for (let i = 0; i < 20; i += 1) {
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, subjectId: `user-${i % 3}` }),
      );
    }

    let stop = false;
    const writer = (async () => {
      let i = 0;
      while (!stop) {
        await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: TENANT, subjectId: `user-${i % 5}` }),
        );
        i += 1;
      }
    })();

    try {
      for (let i = 0; i < 30; i += 1) {
        const aggregate = await memoryStore.aggregateScope(ctx, {});
        const sumOfGroups = aggregate.groups.reduce((sum, g) => sum + g.count, 0);
        expect(sumOfGroups).toBe(aggregate.totalInScope);
      }
    } finally {
      stop = true;
      await writer;
    }
  }, 60_000);
});
