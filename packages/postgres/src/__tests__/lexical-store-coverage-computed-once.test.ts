import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildLexicalSearchSelect } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #878: `PostgresLexicalStore.search` が `query` を語に分解する仕事
 * （`mnemora_lexical_query_tsqueries`、`migrations/0009_*.sql`）を、候補行1つに
 * つき1回だけ行い、行数ぶん繰り返さないことの実測。
 *
 * **時間ではなく `EXPLAIN` の計画の形で見る**（CI で環境ごとの秒数のブレに揺れない
 * ため）——`buildLexicalSearchSelect` の doc が「`WITH qc AS MATERIALIZED (...)` で
 * 1回だけ計算する」と書いている構造そのものを、`EXPLAIN (ANALYZE, FORMAT JSON)` の
 * `Actual Loops` で裏取りする。`qc`（`mnemora_lexical_query_tsqueries` を計算する
 * CTE の生成ノード、`Subplan Name: "CTE qc"`）の `Actual Loops` は、候補行が何行
 * 一致しても常に `1` でなければならない——`1` より大きければ、候補行ごとに
 * `query` の分解をやり直している（Issue #878 が直す前の形に戻っている）ことを意味する。
 *
 * ⚠ この歯は「`qc` という名前の `WITH` 句がある」という実装の形そのものを見ている。
 * `buildLexicalSearchSelect` が別の実装（例: 別名の CTE、別の計算共有の手段）に
 * 変わったら、この歯も追随して直す必要がある——`lexical-store-index.test.ts` の
 * `EXPLAIN` の歯と同じ立場（実装の形を見る歯であって、`LexicalStore` の契約を
 * 見る歯ではない）。
 */

const TENANT = "lexical-coverage-computed-once-tenant";
// 候補行が複数あることだけを確かめたい歯であり、行数そのものに意味は無い
// （`lexical-store-index.test.ts` のような索引選択の実測ではないため、大きな行数は要らない）。
const ROW_COUNT = 8;

async function seedMatchingMemories(pool: Pool, tenant: string, rowCount: number): Promise<void> {
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
      'shared vocabulary token appears in every row ' || i,
      'seed-content-hash-' || i,
      'seed digest ' || i,
      'llm',
      'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      'active',
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
  await pool.query("ANALYZE memories");
}

/** `EXPLAIN (FORMAT JSON)` の Plan 木を再帰的に舐めて、指定した `Subplan Name` を持つノードを探す。 */
function findSubplanNode(
  plan: unknown,
  subplanName: string,
): { "Actual Loops": number } | undefined {
  if (plan === null || typeof plan !== "object") {
    return undefined;
  }
  const node = plan as Record<string, unknown>;
  if (node["Subplan Name"] === subplanName) {
    return node as unknown as { "Actual Loops": number };
  }
  const children = node["Plans"];
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findSubplanNode(child, subplanName);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

describe("PostgresLexicalStore.search: query の分解は候補行ごとにやり直さない（Issue #878）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("候補行が複数あっても、query を語に分解する CTE の生成ノードは1回しか実行されない", async () => {
    const { db, pool } = await getTestClient();
    await seedMatchingMemories(pool, TENANT, ROW_COUNT);

    const ctx: Ctx = { tenantId: TENANT };
    const select = buildLexicalSearchSelect("shared vocabulary token appears row", {
      limit: 50,
      filter: { tenantId: ctx.tenantId, status: ["active", "contested"] },
    });
    const result = await db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${select}`);
    const planRoot = (result.rows[0] as unknown as { "QUERY PLAN": [{ Plan: unknown }] })[
      "QUERY PLAN"
    ][0].Plan;

    const cteProducerNode = findSubplanNode(planRoot, "CTE qc");
    expect(cteProducerNode, "CTE qc の生成ノードが見つかること").toBeDefined();
    expect(cteProducerNode?.["Actual Loops"]).toBe(1);
  }, 60_000);
});
