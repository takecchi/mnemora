import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  captureClientQuery,
  closeTestClient,
  explainCaptured,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 索引の存在と定義だけを見る歯では、プランナが選ばなくなっても緑のままになる（索引が飾りになる）ので、
 * Index Only Scan が選ばれることまで EXPLAIN で見る。期待値は時間ではなく計画の形で書く。
 * プランナ依存で不安定になりうるので、行数（60,000）・統計（`VACUUM ANALYZE`）を揃え、対象 subject の
 * active な claim key 行が全体の一部になる偏りのあるデータにしてある。⚠ 版・統計・データ規模に依存する。
 * 索引の定義は別の `it` で `pg_get_indexdef` を見る（EXPLAIN が不安定になったときも定義の歯は残る）。
 */

const TENANT = "claim-predicates-index";
const ROWS = 60_000;
const SUBJECTS = 100;
const STATUSES = ["active", "superseded", "contested", "archived", "forgotten"];

async function seed(pool: Pool): Promise<void> {
  const ids = Array.from({ length: ROWS }, () => randomUUID());
  await pool.query(
    `INSERT INTO memories (id, tenant_id, subject_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
        decay_floor_at, embedding_status, created_at, updated_at, claim_key_subject, claim_key_predicate)
     SELECT m, $2, CASE WHEN i % $3 = 0 THEN NULL ELSE 's' || (i % $3) END, 'c ' || m, md5(m::text), 'd', 'llm',
        'imported', '{"kind":"imported"}'::jsonb,
        CASE WHEN i % 10 < 6 THEN 'active' ELSE ($4::text[])[1 + (i % 10) - 5] END,
        '{}'::text[], now(), 1, 720, now() + interval '30 days', 'ready',
        now() - (i || ' seconds')::interval, now(),
        CASE WHEN i % 3 = 0 THEN 'user' END, CASE WHEN i % 3 = 0 THEN 'p' || (i % 200) END
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(m, i)`,
    [ids, TENANT, SUBJECTS, STATUSES],
  );
  // 統計と visibility map（Index Only Scan は all-visible のページでヒープを読まずに済む）。
  await pool.query("VACUUM ANALYZE memories");
}

describe("listActiveClaimPredicates は idx_memories_claim_predicates で Index Only Scan になる", () => {
  let store: PostgresMemoryStore;
  let pool: Pool;
  const ctx: Ctx = { tenantId: TENANT };

  beforeAll(async () => {
    await resetTestDatabase();
    const client = await getTestClient();
    pool = client.pool;
    store = new PostgresMemoryStore(client.db);
    await seed(pool);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  const listMatcher = (t: string) => /claim_key_predicate/.test(t) && /GROUP BY/i.test(t);

  it("索引の定義は (tenant_id, subject_id, claim_key_predicate, created_at) の部分索引", async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'memories'::regclass AND c.relname = 'idx_memories_claim_predicates'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.def;
    expect(def).toContain("(tenant_id, subject_id, claim_key_predicate, created_at)");
    expect(def).toMatch(/WHERE .*status = 'active'/);
    expect(def).toContain("claim_key_subject IS NOT NULL");
    expect(def).toContain("claim_key_predicate IS NOT NULL");
  });

  it.each([
    ["文字列", "s3"],
    ["null", null],
  ] as const)(
    "subjectId が %s のとき Index Only Scan（Seq Scan にしない）",
    async (_label, subjectId) => {
      const text = await explainCaptured(
        pool,
        await captureClientQuery(listMatcher, () =>
          store.listActiveClaimPredicates(ctx, { subjectId, limit: 20 }),
        ),
      );
      expect(text).toMatch(/Index Only Scan using idx_memories_claim_predicates/);
      expect(text).not.toContain("Seq Scan on memories");
    },
  );
});
