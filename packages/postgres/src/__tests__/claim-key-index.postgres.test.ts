import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  captureClientQuery,
  closeTestClient,
  explainCaptured,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `findContestedByClaimKey` は `findActiveByClaimKey` と `status` のリテラルだけが違う。`idx_memories_claim_key` は
 * `status` を条件に含めない汎用索引なので、新しい索引は要らないことも EXPLAIN で確かめる。
 * 期待値は時間ではなく計画の形で書く（CI で揺れないため）。`subjectId` が文字列のときと `null` のとき
 * （`subject_id IS NULL` で索引を引く）の両方を見る。
 */

const TENANT = "claim-key-index";
const ROWS = 20_000;
const SUBJECTS = 20;

async function seed(pool: Pool): Promise<MemoryId> {
  const ids = Array.from({ length: ROWS }, () => randomUUID());
  await pool.query(
    `INSERT INTO memories (id, tenant_id, subject_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
        decay_floor_at, embedding_status, created_at, updated_at, claim_key_subject, claim_key_predicate)
     SELECT m, $2, CASE WHEN i % $3 = 0 THEN NULL ELSE 's' || (i % $3) END, 'c ' || m, md5(m::text), 'd', 'llm',
        'imported', '{"kind":"imported"}'::jsonb, 'active', '{}'::text[], now(), 1, 720,
        now() + interval '30 days', 'ready', now(), now(),
        CASE WHEN i % 3 = 0 THEN 'user' END, CASE WHEN i % 3 = 0 THEN 'p' || (i % 200) END
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(m, i)`,
    [ids, TENANT, SUBJECTS],
  );
  const other = Array.from({ length: 5_000 }, () => randomUUID());
  await pool.query(
    `INSERT INTO memories (id, tenant_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
        decay_floor_at, embedding_status, created_at, updated_at, claim_key_subject, claim_key_predicate)
     SELECT m, 'claim-key-index-other', 'c', md5(m::text), 'd', 'llm', 'imported', '{"kind":"imported"}'::jsonb,
        'active', '{}'::text[], now(), 1, 720, now() + interval '30 days', 'ready', now(), now(), 'user', 'p1'
     FROM unnest($1::uuid[]) AS m`,
    [other],
  );
  // `findContestedByClaimKey` の EXPLAIN も見るため、`contested` な行も同じ分布で作る。`contested` の行数がある程度無いと、
  // プランナが `idx_memories_claim_key` より `idx_memories_contested` を安く見積もることがある（0行なら後者はほぼ即座に空を返せるため）。
  const contested = Array.from({ length: ROWS }, () => randomUUID());
  await pool.query(
    `INSERT INTO memories (id, tenant_id, subject_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
        decay_floor_at, embedding_status, created_at, updated_at, claim_key_subject, claim_key_predicate)
     SELECT m, $2, CASE WHEN i % $3 = 0 THEN NULL ELSE 's' || (i % $3) END, 'c ' || m, md5(m::text), 'd', 'llm',
        'imported', '{"kind":"imported"}'::jsonb, 'contested', '{}'::text[], now(), 1, 720,
        now() + interval '30 days', 'ready', now(), now(),
        CASE WHEN i % 3 = 0 THEN 'user' END, CASE WHEN i % 3 = 0 THEN 'p' || (i % 200) END
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(m, i)`,
    [contested, TENANT, SUBJECTS],
  );
  // 統計が無いと、プランナが誤った見積もりで無関係な索引や Seq Scan を選ぶ。
  await pool.query("ANALYZE memories");
  return ids[5]! as MemoryId;
}

describe("claimKey の SQL は idx_memories_claim_key を subject_id まで使う（Seq Scan にしない）", () => {
  let store: PostgresMemoryStore;
  let pool: Pool;
  let someId: MemoryId;
  const ctx: Ctx = { tenantId: TENANT };

  beforeAll(async () => {
    await resetTestDatabase();
    const client = await getTestClient();
    pool = client.pool;
    store = new PostgresMemoryStore(client.db);
    someId = await seed(pool);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function plan(matcher: (text: string) => boolean, fn: () => Promise<unknown>) {
    return explainCaptured(pool, await captureClientQuery(matcher, fn));
  }

  const findMatcher = (t: string) =>
    /claim_key_subject\s*=/.test(t) && /content_hash/.test(t) && /status\s*=\s*'active'/.test(t);
  const findContestedMatcher = (t: string) =>
    /claim_key_subject\s*=/.test(t) && /content_hash/.test(t) && /status\s*=\s*'contested'/.test(t);
  const listMatcher = (t: string) => /claim_key_predicate/.test(t) && /GROUP BY/i.test(t);

  it.each([
    ["文字列", "s3"],
    ["null", null],
  ] as const)("findActiveByClaimKey（subjectId が %s）", async (_label, subjectId) => {
    const text = await plan(findMatcher, () =>
      store.findActiveByClaimKey(ctx, {
        subjectId,
        claimKey: { subject: "user", predicate: "p3" },
        excludeMemoryId: someId,
        contentHash: "no-such-hash",
        validFrom: null,
        validUntil: null,
      }),
    );
    // 緩めた理由: 部分索引 `idx_memories_claim_predicates` も `findActiveByClaimKey` のプランナが選びうるため。
    // 残した確認: Seq Scan にならない・`subject_id` が Index Cond に入る（下の2行）。
    expect(text).toMatch(/idx_memories_claim_(key|predicates)/);
    expect(text).not.toContain("Seq Scan on memories");
    expect(text).toMatch(/(Index|Recheck) Cond: [^\n]*subject_id/);
  });

  it.each([
    ["文字列", "s3"],
    ["null", null],
  ] as const)("findContestedByClaimKey（subjectId が %s）", async (_label, subjectId) => {
    const text = await plan(findContestedMatcher, () =>
      store.findContestedByClaimKey(ctx, {
        subjectId,
        claimKey: { subject: "user", predicate: "p3" },
        excludeMemoryId: someId,
        contentHash: "no-such-hash",
        validFrom: null,
        validUntil: null,
      }),
    );
    expect(text).toContain("idx_memories_claim_key");
    expect(text).not.toContain("Seq Scan on memories");
    expect(text).toMatch(/(Index|Recheck) Cond: [^\n]*subject_id/);
  });

  it.each([
    ["文字列", "s3"],
    ["null", null],
  ] as const)("listActiveClaimPredicates（subjectId が %s）", async (_label, subjectId) => {
    const text = await plan(listMatcher, () =>
      store.listActiveClaimPredicates(ctx, { subjectId, limit: 50 }),
    );
    // 緩めた理由: 部分索引 `idx_memories_claim_predicates` を `listActiveClaimPredicates` のプランナが選ぶため。
    // 残した確認: Seq Scan にならない・`subject_id` が Index Cond に入る（下の2行。Index Only Scan は専用の歯が見る）。
    expect(text).toMatch(/idx_memories_claim_(key|predicates)/);
    expect(text).not.toContain("Seq Scan on memories");
    expect(text).toMatch(/(Index|Recheck) Cond: [^\n]*subject_id/);
  });

  // 上の歯は `subject_id` が Index Cond に入ることまでしか見ない。述語（claim_key_predicate）の比較が索引で引けない形に変わると、
  // 索引は subject までで止まり、同じ subject の全 claim key の行を読んで Filter で捨てるのに、上の歯は緑のままになる。
  it.each([
    ["findActiveByClaimKey", "文字列", "s3", findMatcher],
    ["findActiveByClaimKey", "null", null, findMatcher],
    ["findContestedByClaimKey", "文字列", "s3", findContestedMatcher],
    ["findContestedByClaimKey", "null", null, findContestedMatcher],
  ] as const)(
    "%s は claim_key_predicate の等値も Index Cond に入れる（subjectId が %s）",
    async (method, _label, subjectId, matcher) => {
      const text = await plan(matcher, () =>
        store[method](ctx, {
          subjectId,
          claimKey: { subject: "user", predicate: "p3" },
          excludeMemoryId: someId,
          contentHash: "no-such-hash",
          validFrom: null,
          validUntil: null,
        }),
      );
      // `claim_key_predicate IS NOT NULL`（部分索引の述語。Recheck Cond に出る）では通らないよう、等値まで見る。
      expect(text).toMatch(/(Index|Recheck) Cond: [^\n]*claim_key_predicate = 'p3'/);
    },
  );
});
