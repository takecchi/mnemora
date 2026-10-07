import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildLexicalSearchSelect } from "../lexical-store.js";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「対照」テストが `idx_memories_lexical` を作り直すための DDL。マイグレーションファイルから切り出して読む（書き写すと、migration を直したときにこの復元だけ古い定義のまま静かにずれる）。
 * `migrations/0025_*.sql` は `CREATE FUNCTION`（非冪等）を持つので、ファイル全体を流し直さず、末尾の `CREATE INDEX ...` 文だけを切り出す。
 * 0008 の文は `DROP INDEX` 済みの古い式で索引を作ってしまい、`search` が実際に使う式（0025 の式）とずれるので使わない。
 */
const MIGRATION_0025_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0025_lexical_tsvector_fallback.sql"),
  "utf8",
);
const CREATE_INDEX_SQL = MIGRATION_0025_SQL.slice(
  MIGRATION_0025_SQL.indexOf("CREATE INDEX idx_memories_lexical"),
);

/**
 * 本体と同じ `SELECT` を `EXPLAIN` する（テスト側に述語を書き写さない）。
 * `filter.status` に `['active', 'contested']` を明示して渡す。`idx_memories_lexical` は `WHERE status IN ('active', 'contested')` の部分索引で、クエリ側がこの2値だけに絞ってはじめて索引の述語を含意できる。
 *
 * ⚠ この歯はプランナの選択を assert しており、版・統計・データ規模に依存する。赤くなったら、自分の変更の前に Postgres のメジャー版・ANALYZE・統計情報を疑い、まず `origin/main` で対照を取ること。
 */

const TENANT = "lexical-index-tenant";
// GIN の部分索引を Seq Scan より優先させるため、行数を多めに用意する。
const ROW_COUNT = 20_000;

/**
 * `memories` に大量行を投入する。大半を `active`、少量を `contested`、残りを索引対象外の状態に散らす。
 * クエリ語「obsidian shards」を含む行は 50 行に1行（2%）だけにして、語彙一致の選択性が高い状態を再現する。含まない行は語彙が全く重ならない日本語の埋め文で埋める。
 */
async function seedManyMemories(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      last_reinforced_at, strength, half_life_hours, decay_floor_at,
      embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      NULL,
      CASE WHEN i % 50 = 0 THEN 'obsidian shards glimmer in seed content ' || i
           ELSE '関係の無い埋め文その' || i END,
      'seed-content-hash-' || i,
      'seed digest ' || i,
      'llm',
      'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      CASE
        WHEN i % 100 = 0 THEN 'contested'
        WHEN i % 100 = 1 THEN 'archived'
        ELSE 'active'
      END,
      '{}',
      NULL,
      now() - (i || ' seconds')::interval,
      NULL,
      1.0,
      720,
      now() + interval '30 days',
      'ready',
      now() - (i || ' seconds')::interval,
      now() - (i || ' seconds')::interval
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無い/古いと、プランナが誤った行数見積もりで Seq Scan や無関係な索引を選ぶ。
  await pool.query("ANALYZE memories");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

async function explainSearch(): Promise<string> {
  const { db } = await getTestClient();
  const ctx: Ctx = { tenantId: TENANT };
  const select = buildLexicalSearchSelect("obsidian shards", {
    limit: 50,
    filter: { tenantId: ctx.tenantId, status: ["active", "contested"] },
    ctxTenantId: ctx.tenantId,
  });
  const result = await db.execute(sql`EXPLAIN (FORMAT TEXT) ${select}`);
  return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
}

describe("idx_memories_lexical（ADR 0084、Issue #106）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("PostgresLexicalStore.search が実際に打つ SELECT で idx_memories_lexical が使われ、Seq Scan on memories は選ばれない", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const plan = await explainSearch();
    console.log(`=== EXPLAIN（idx_memories_lexical、行数 ${ROW_COUNT}）===\n${plan}`);

    expect(plan).toContain("idx_memories_lexical");
    expect(plan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  it("参考: idx_memories_lexical を落とすと Seq Scan on memories になる（対照。プランナが本当にこの索引を選んでいたことの裏取り）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    await pool.query("DROP INDEX idx_memories_lexical");
    try {
      const plan = await explainSearch();
      console.log(`=== EXPLAIN（idx_memories_lexical 無し、対照）===\n${plan}`);
      expect(plan).toMatch(/Seq Scan on memories/);
    } finally {
      // マイグレーションファイルから切り出した DDL で元に戻す。DROP したままだと、同じプロセス内で後から走る他のテストまで索引の無い状態を引きずる。
      await pool.query(CREATE_INDEX_SQL);
    }
  }, 60_000);
});
