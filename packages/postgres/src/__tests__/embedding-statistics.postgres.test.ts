import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { INITIAL_ANALYZE_THRESHOLD } from "../embedding-statistics.js";
import { requireDatabaseUrl, seededRandom } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * (甲) は埋め込み表について一切 `ANALYZE` を撃たない。`PostgresVectorStore.upsert` 自身が内部で撃つことだけを頼りに HNSW を成立させるのが、この歯の存在理由である。
 *
 * (甲) が EXPLAIN するのは `search()` の実発行 SQL ではなく、`memories` と JOIN しない SQL である。
 * この歯の使い捨てデータベースの `memories` には一度も `ANALYZE` が走らず、`JOIN` を含む SQL ではプランナが `memories` の行数を見誤り、
 * HNSW を検討する前に安い Nested Loop を選びうる。この歯が検査したいのは埋め込み表の統計だけなので、`memories` を変数から外す。
 *
 * 使い捨てデータベースを使うのは、他のテストファイルが積んだ行・`ANALYZE` のノイズから隔離するため。
 * `ALTER TABLE ... SET (autovacuum_enabled = false)` を投入前に打つのは、切らないと
 * 「upsert 内蔵の ANALYZE が効いた」のか「autovacuum がたまたま拾った」のか区別が付かず、この歯が何も証明しなくなるため。
 */

const TEST_DATABASE = "mnemora_embedding_statistics_test";
const TENANT = "embedding-statistics-tenant";

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function uniqueSpace(label: string): EmbeddingSpaceId {
  return {
    provider: "embedding-statistics-test",
    model: `${label}-${randomUUID()}`,
    dimensions: 3,
  };
}

async function disableAutovacuum(pool: Pool, table: string): Promise<void> {
  await pool.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
}

describe("PostgresVectorStore.upsert と ANALYZE の自動発火（Issue #360 / ADR 0194）", () => {
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    await dropTempDatabase(admin(), TEST_DATABASE);
    await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
    client = createPostgresClient(connectionStringFor(TEST_DATABASE));
    await runMigrations(client.pool);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await closePostgresClient(client);
    }
    await dropTempDatabase(admin(), TEST_DATABASE);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 30_000);

  it("(甲) 新しい空間へ upsert だけで閾値を越える行数を書くと、テスト側が一度も ANALYZE を撃たなくても HNSW 索引が選ばれる", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const space = uniqueSpace("crossing");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);
    await disableAutovacuum(pool, table);

    // 4,000 = 4 * INITIAL_ANALYZE_THRESHOLD。等比の閾値（1,000 / 2,000 / 4,000）にちょうど一致させ、最後の ANALYZE が投入完了時点の行数と過不足なく一致するようにする。
    const rowCount = 4 * INITIAL_ANALYZE_THRESHOLD;
    const rand = seededRandom(20260917);
    for (let i = 0; i < rowCount; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    // 事前条件: autovacuum を切ってあるので、ここまでに走った ANALYZE は upsert 内蔵のもの以外にありえない。
    // last_analyze は明示 ANALYZE 用の列で、autovacuum が動かす last_autoanalyze とは別。
    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = $1`,
      [table],
    );
    expect(statResult.rows[0]?.last_analyze).not.toBeNull();
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT memory_id, embedding <=> '[0.5,0.5,0.5]'::vector AS distance
       FROM ${table}
       WHERE tenant_id = $1
       ORDER BY embedding <=> '[0.5,0.5,0.5]'::vector
       LIMIT 10`,
      [TENANT],
    );
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);

  it("(乙) 統計が既に十分な表では、upsert が閾値を跨いでも ANALYZE を撃たない（last_analyze が動かない）", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const space = uniqueSpace("guard");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);
    await disableAutovacuum(pool, table);

    // 生 SQL で直接 INSERT する。`vectorStore.upsert()` を使うとこのテーブルのプロセスカウンタが進み、「まだ upsert していないのに統計だけ大きい」という状況を作れない。
    const rand = seededRandom(20260917001);
    const preExistingCount = INITIAL_ANALYZE_THRESHOLD + 100; // 1,100
    for (let i = 0; i < preExistingCount; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await pool.query(
        `INSERT INTO ${table} (tenant_id, memory_id, embedding, model, created_at)
           VALUES ($1, $2, $3::vector, $4, now())`,
        [TENANT, memory.id, `[${vector.join(",")}]`, space.model],
      );
    }

    await pool.query(`ANALYZE ${table}`);
    const beforeStat = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = $1`,
      [table],
    );
    const lastAnalyzeBefore = beforeStat.rows[0]?.last_analyze;
    expect(lastAnalyzeBefore).not.toBeNull();

    // このプロセスの upsert カウンタはこのテーブルについてまだ0で、ちょうど `INITIAL_ANALYZE_THRESHOLD` 回だけ upsert を呼んで閾値を跨がせる。
    // reltuples はこのプロセスの累計以上なので、guard により ANALYZE は撃たれないはずである。
    for (let i = 0; i < INITIAL_ANALYZE_THRESHOLD; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    const afterStat = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = $1`,
      [table],
    );
    expect(afterStat.rows[0]?.last_autoanalyze).toBeNull();
    expect(afterStat.rows[0]?.last_analyze).toEqual(lastAnalyzeBefore);
  }, 120_000);
});
