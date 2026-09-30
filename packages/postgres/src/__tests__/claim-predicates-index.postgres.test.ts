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
 * `listActiveClaimPredicates` が `idx_memories_claim_predicates`
 * （`migrations/0029_memories_claim_predicates_index.sql`、ADR 0329 の 2026-09-30 追記）で
 * **Index Only Scan** になること、と索引の定義。`claim-key-index.postgres.test.ts`（汎用の
 * `idx_memories_claim_key` の歯）と同じ形で、期待値は時間ではなく計画の形で書く。
 *
 * ## なぜ EXPLAIN の歯にしたか（定義の確認だけにしなかった）
 *
 * 索引の存在と定義だけを見る歯なら、プランナが選ばなくなっても緑のままになる（索引が
 * 飾りになる）。`status` を部分索引の述語へ移した理由は「問い合わせの `WHERE` と同じ形なので
 * プランナが述語を導ける」ことなので、選ばれることまで見る。プランナ依存で不安定になりうるので、
 * 行数（60,000）・統計（`VACUUM ANALYZE`。visibility map を all-visible にして Index Only Scan
 * を選ばせる）を揃え、Index Only Scan を選ぶほど十分に偏りのあるデータ（対象 subject の
 * active な claim key 行は全体の一部）にしてある。⚠ 版・統計・データ規模に依存する
 * （`trigram-lexical-store-index.postgres.test.ts` と同じ留保）。索引の定義は別の `it` で
 * `pg_get_indexdef` を見る（EXPLAIN が不安定になったときも定義の歯は残る）。
 */

const TENANT = "claim-predicates-index";
const ROWS = 60_000;
const SUBJECTS = 100;
const STATUSES = ["active", "superseded", "contested", "archived", "forgotten"];

async function seed(pool: Pool): Promise<void> {
  const ids = Array.from({ length: ROWS }, () => randomUUID());
  // status は i % 10 で active 6割・他4種が各1割。claim key は3行に1行。subject は
  // 's1'..'s99'、i % 100 = 0 の行は subject なし。predicate は 200 種。
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
