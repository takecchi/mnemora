import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * claimKey の Postgres の2つの約束の歯（Issue #1775 の #736）。
 *
 * 1. **片方だけ NULL の行を鍵として読まない**（`mapping.ts` の doc・`memory.ts` の `claimKey` の doc、
 *    migration の「CHECK で強制しない」決定）。書き込みの口は片方だけの鍵・空文字の鍵を拒む（ADR 0630）が、
 *    以前の行や生 SQL の行は片方だけ NULL でありうる。読み戻した Memory は `claimKey: null` で、
 *    `findActiveByClaimKey` に一致せず、`listActiveClaimPredicates` に数えられない。
 *    migration に CHECK を足すと、生 SQL の INSERT が落ちてこの歯が赤になる。
 * 2. **索引 `idx_memories_claim_key` の形**（PR 本文・ADR 0320 決定7・8、ADR 0378）: 列順は
 *    `(tenant_id, subject_id, claim_key_subject, claim_key_predicate)`、部分索引
 *    （`WHERE claim_key_subject IS NOT NULL`）、`status` を列に含めない汎用索引。
 *    4列とも等値の検索では計画が列順に依らず索引を使うので、計画の歯（`claim-key-index.postgres.test.ts`）は
 *    これを見ない。カタログ（`pg_index`・`pg_attribute`）から読む（`pg_get_indexdef` の整形は版で変わる）。
 */

const TENANT = "claim-key-partial-row";
const ctx: Ctx = { tenantId: TENANT };

async function insertRaw(
  pool: Pool,
  id: string,
  claimKeySubject: string | null,
  claimKeyPredicate: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO memories (id, tenant_id, subject_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
        decay_floor_at, embedding_status, created_at, updated_at, claim_key_subject, claim_key_predicate)
     VALUES ($1::uuid, $2, NULL, $3, md5($1::text), 'd', 'llm', 'imported', '{"kind":"imported"}'::jsonb,
        'active', '{}'::text[], now(), 1, 720, now() + interval '30 days', 'ready', now(), now(), $4, $5)`,
    [id, TENANT, `content ${id}`, claimKeySubject, claimKeyPredicate],
  );
}

describe("claimKey: 片方だけ NULL の行（生 SQL）は鍵として読まれない", () => {
  let pool: Pool;
  let store: PostgresMemoryStore;

  beforeAll(async () => {
    await resetTestDatabase();
    const client = await getTestClient();
    pool = client.pool;
    store = new PostgresMemoryStore(client.db);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("getMemory は claimKey を null で返し、findActiveByClaimKey は一致させず、listActiveClaimPredicates は数えない", async () => {
    const onlySubject = randomUUID();
    const onlyPredicate = randomUUID();
    const complete = randomUUID();
    await insertRaw(pool, onlySubject, "user", null);
    await insertRaw(pool, onlyPredicate, null, "orphan_predicate");
    await insertRaw(pool, complete, "user", "favorite_food");

    // 読み戻し: 片方だけ NULL の行は、鍵なしの Memory になる。
    expect((await store.get(ctx, onlySubject))?.claimKey ?? null).toBeNull();
    expect((await store.get(ctx, onlyPredicate))?.claimKey ?? null).toBeNull();
    expect((await store.get(ctx, complete))?.claimKey).toEqual({
      subject: "user",
      predicate: "favorite_food",
    });

    // 一致: 片方だけの行は、どちらの鍵にも当たらない（陽性対照: 完全な鍵の行は当たる）。
    const query = (predicate: string) => ({
      subjectId: null,
      claimKey: { subject: "user", predicate },
      excludeMemoryId: randomUUID(),
      contentHash: "no-such-hash",
      validFrom: null,
      validUntil: null,
    });
    const matchedComplete = await store.findActiveByClaimKey(ctx, query("favorite_food"));
    expect(matchedComplete.map((m) => m.id)).toEqual([complete]);
    expect(await store.findActiveByClaimKey(ctx, query("orphan_predicate"))).toEqual([]);

    // predicate 一覧: 完全な鍵の行だけが数えられる。
    const predicates = await store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 100 });
    expect(predicates).toEqual(["favorite_food"]);
  });
});

describe("claimKey: 索引 idx_memories_claim_key の形（カタログから読む。ADR 0320 決定7・8）", () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetTestDatabase();
    pool = (await getTestClient()).pool;
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("列順は tenant_id, subject_id, claim_key_subject, claim_key_predicate で、status を含まず、部分索引である", async () => {
    const { rows } = await pool.query<{ columns: string[]; has_predicate: boolean }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns,
              (i.indpred IS NOT NULL) AS has_predicate
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE c.relname = 'idx_memories_claim_key'
        GROUP BY i.indpred`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.columns).toEqual([
      "tenant_id",
      "subject_id",
      "claim_key_subject",
      "claim_key_predicate",
    ]);
    expect(rows[0]!.columns).not.toContain("status");
    expect(rows[0]!.has_predicate).toBe(true);
  });
});
