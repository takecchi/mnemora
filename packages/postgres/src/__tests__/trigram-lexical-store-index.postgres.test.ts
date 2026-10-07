import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildTrigramLexicalSearchSelect,
  createOptionalTrigramIndex,
  DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD,
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `createOptionalTrigramIndex` が張る `idx_memories_trigram` が、`PostgresTrigramLexicalStore.search` と
 * **同じ `SELECT`**（`buildTrigramLexicalSearchSelect`）で実際に選ばれることの実測。
 * `lexical-store-index.test.ts`（`idx_memories_lexical`）と同じ作法で置く。
 *
 * ⚠ **この歯はプランナの選択を assert している**——版・統計・データ規模に依存する
 * （`lexical-store-index.test.ts` と同じ留保）。`server_encoding` が `UTF8` でないクラスタでは trigram の
 * store が使えないので、probe の理由だけを確かめる。
 */

const TENANT = "trigram-index-tenant";
const ROW_COUNT = 20_000;
const QUERY = "田中さんが会議";

async function seedManyMemories(pool: Pool): Promise<void> {
  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      last_reinforced_at, strength, half_life_hours, decay_floor_at,
      embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(), $1, NULL,
      CASE WHEN i % 50 = 0 THEN '田中さんが会議に参加します その' || i
           ELSE 'まったく関係の無い埋め文です その' || i END,
      'seed-content-hash-' || i, 'seed digest ' || i, 'llm', 'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      CASE WHEN i % 100 = 0 THEN 'contested' WHEN i % 100 = 1 THEN 'archived' ELSE 'active' END,
      '{}', NULL, now() - (i || ' seconds')::interval, NULL, 1.0, 720,
      now() + interval '30 days', 'ready',
      now() - (i || ' seconds')::interval, now() - (i || ' seconds')::interval
    FROM generate_series(1, $2) AS i
    `,
    [TENANT, ROW_COUNT],
  );
  await pool.query("ANALYZE memories");
}

/** 本体と同じ形（同じトランザクションで閾値を設定してから `SELECT`）で `EXPLAIN` する。 */
async function explainSearch(): Promise<string> {
  const { db } = await getTestClient();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD)}, true)`,
    );
    const select = buildTrigramLexicalSearchSelect(QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
      threshold: DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD,
      ctxTenantId: TENANT,
    });
    const result = await tx.execute(sql`EXPLAIN ${select}`);
    return (result.rows as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
  });
}

afterAll(async () => {
  const { pool } = await getTestClient();
  await pool.query("DROP INDEX IF EXISTS idx_memories_trigram");
  await closeTestClient();
});

describe("idx_memories_trigram が PostgresTrigramLexicalStore.search の SELECT で選ばれる（実測）", () => {
  it("索引があれば idx_memories_trigram を使い、無ければ Seq Scan on memories になる", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      expect(probe.reason).toBe("server_encoding_not_utf8");
      return;
    }
    await PostgresTrigramLexicalStore.create(db);
    await seedManyMemories(pool);

    await pool.query("DROP INDEX IF EXISTS idx_memories_trigram");
    const withoutIndex = await explainSearch();
    expect(withoutIndex).toMatch(/Seq Scan on memories/);

    await createOptionalTrigramIndex(db);
    await pool.query("ANALYZE memories");
    const withIndex = await explainSearch();
    console.log(`=== EXPLAIN（idx_memories_trigram、行数 ${ROW_COUNT}）===\n${withIndex}`);
    expect(withIndex).toContain("idx_memories_trigram");
    expect(withIndex).not.toMatch(/Seq Scan on memories/);
  }, 120_000);
});
