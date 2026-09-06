import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
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

const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

/**
 * マネージャー報告の問題そのものを検査する: 段1（索引が効くフィルタ + ANN 検索）が
 * `subject` で絞っていないと、大規模テナントで小さい subject を引くとき、
 * over-fetch の窓（k' = limit * overFetchFactor）がテナント全体の近傍で埋まってしまい、
 * その subject の記憶が1件も窓に入らず recall から黙って落ちうる
 * （packages/core/src/recall-runtime.ts 段1のコメント参照）。
 *
 * ⚠ クエリ文字列を記憶の本文と完全一致させて距離0にする手はここでは使えない
 * ——距離0なら subject で絞らなくても全体の1位になるので、修正前でも緑になってしまい
 * この歯が噛まない。そのためベクトルを直接指定し、狙った順位を作る
 * （vector-search-hnsw.test.ts の作法に倣う）。
 */

const TENANT = "subject-filter-tenant";
const CROWD_COUNT = 500;
const SMALL_COUNT = 3;
const LIMIT = 40;
const QUERY_VECTOR: number[] = [1, 0, 0];

async function seedCrowdAndSmall(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  pool: Pool,
): Promise<{ crowdIds: string[]; smallIds: string[] }> {
  const rand = seededRandom(20260906);
  const noisy = (base: number[], scale: number): number[] =>
    base.map((v) => v + (rand() - 0.5) * scale);

  const crowdIds: string[] = [];
  for (let i = 0; i < CROWD_COUNT; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, subjectId: "crowd" }),
    );
    // クエリベクトルのすぐ近く（cosine 距離 ~0）に大量に置く。
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, noisy(QUERY_VECTOR, 0.02));
    crowdIds.push(memory.id);
  }

  const smallIds: string[] = [];
  for (let i = 0; i < SMALL_COUNT; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, subjectId: "small" }),
    );
    // クエリベクトルから遠く（cosine 距離 ~2、ほぼ正反対）に少数だけ置く。
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, noisy([-1, 0, 0], 0.02));
    smallIds.push(memory.id);
  }

  // ANALYZE: 統計情報が無い/古いと HNSW 索引が選ばれないことがある（vector-search-hnsw.test.ts と同じ理由）。
  await pool.query(`ANALYZE ${TABLE}`);
  await pool.query("ANALYZE memories");

  return { crowdIds, smallIds };
}

describe("PostgresVectorStore.search — subject フィルタが段1に効くこと（歯A）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("subjectId で絞ると窓は small の3件になり、絞らないと窓は crowd(40件)で埋まり small は0件になる", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { smallIds } = await seedCrowdAndSmall(memoryStore, vectorStore, ctx, pool);

    // 修正前の段1呼び出しと同じ形（subjectId を渡さない）。
    const withoutSubjectFilter = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
      limit: LIMIT,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    expect(withoutSubjectFilter).toHaveLength(40);
    const smallIdSet = new Set(smallIds);
    const smallHitsWithoutFilter = withoutSubjectFilter.filter((h) => smallIdSet.has(h.memoryId));
    expect(smallHitsWithoutFilter).toHaveLength(0);

    // 修正後: subjectId: "small" を渡す。
    const withSubjectFilter = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
      limit: LIMIT,
      filter: { tenantId: TENANT, status: ["active", "contested"], subjectId: "small" },
    });
    expect(withSubjectFilter).toHaveLength(3);
    expect(new Set(withSubjectFilter.map((h) => h.memoryId))).toEqual(smallIdSet);
  }, 120_000);
});

/**
 * 歯B（EXPLAIN）: `m.subject_id = $x` を足した形の段1クエリでも HNSW 索引が使われるかを検査する。
 *
 * ⚠ マネージャー指示: もし HNSW が使われなくなっているなら、それは重要な発見である。
 * この assertion をごまかして緑にしない——手元に DB が無いため、この歯自体は実行できていない。
 * 実際に何が起きるかは CI での実測に委ねる。
 */
const EXPLAIN_TENANT = "hnsw-subject-explain-tenant";
const EXPLAIN_ROW_COUNT = 3000;

async function seedForExplain(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  pool: Pool,
) {
  const rand = seededRandom(20260906 + 1);
  for (let i = 0; i < EXPLAIN_ROW_COUNT; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, subjectId: `subject-${i % 100}` }),
    );
    const vector = [rand(), rand(), rand()];
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  }
  // 統計情報が無い/古いままだと、プランナが誤った行数見積もりで意図しない索引を選ぶ
  // （vector-search-hnsw.test.ts の実測コメントと同じ理由）。
  await pool.query(`ANALYZE ${TABLE}`);
  await pool.query("ANALYZE memories");
}

describe("PostgresVectorStore.search — subject_id を足しても HNSW 索引が使われるか（歯B）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("m.subject_id = $x を足した形の段1クエリでも EXPLAIN に HNSW 索引が出る（再現用の等価クエリ）", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: EXPLAIN_TENANT };
    await seedForExplain(memoryStore, vectorStore, ctx, pool);

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
         SELECT e.memory_id AS memory_id, e.embedding <=> '[0.5,0.5,0.5]'::vector AS distance
         FROM ${TABLE} e
         JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
         WHERE e.tenant_id = $1 AND m.status = ANY($2::text[]) AND m.subject_id = $3
         ORDER BY e.embedding <=> '[0.5,0.5,0.5]'::vector
         LIMIT 40`,
      [EXPLAIN_TENANT, ["active", "contested"], "subject-7"],
    );
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 120_000);

  it("PostgresVectorStore.search が subjectId 込みで実際に発行するクエリ自体が EXPLAIN で HNSW 索引を使う", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: EXPLAIN_TENANT };
    await seedForExplain(memoryStore, vectorStore, ctx, pool);

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
      await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [0.5, 0.5, 0.5], {
        limit: 40,
        filter: {
          tenantId: EXPLAIN_TENANT,
          status: ["active", "contested"],
          subjectId: "subject-7",
        },
      });
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
  }, 120_000);
});
