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
 * 抽出時の矛盾検出（claimKey）が打つ3つの SQL——`findActiveByClaimKey`・
 * `findContestedByClaimKey`（Issue #933 案2、ADR 0378）・`listActiveClaimPredicates`——が、
 * `idx_memories_claim_key`
 * （`(tenant_id, subject_id, claim_key_subject, claim_key_predicate) WHERE claim_key_subject IS NOT NULL`、
 * `migrations/0021_memories_claim_key.sql`）を **`subject_id` まで**索引の条件に使うこと。
 *
 * `findContestedByClaimKey` は `findActiveByClaimKey` と完全に同じクエリ形で `status` の
 * リテラルだけが違う（`'active'` → `'contested'`）。この索引は `status` を条件に含めない
 * 汎用索引（`0021_memories_claim_key.sql` の doc コメント）なので、新しい索引・新しい
 * migration は要らない——ここではそれを EXPLAIN で確かめる。
 *
 * 【実測 2026-09-27、1テナント 20,000 行（20 subject）+ 別テナント 5,000 行、ANALYZE 済み】以前は:
 * - `listActiveClaimPredicates` は **Seq Scan**（別テナントを含む表全体を走査）。
 *   `knownPredicatesFromStore` を有効にすると observe のたびに呼ばれる。doc コメントは
 *   「先頭2列（tenant_id, subject_id）で絞り込む」と書いていたが、実際には索引を使っていなかった。
 * - `findActiveByClaimKey` は索引を使うが、`subject_id` は Index Cond に入らず Filter に落ちていた
 *   （同じ claim key を持つテナント中の全 subject の行を読んでから subject で捨てる）。
 * 原因は `subject_id IS NOT DISTINCT FROM $n`（索引で引けない形）と、部分索引の述語
 * （`claim_key_subject IS NOT NULL`）を WHERE から導けないこと。
 *
 * 期待値は時間ではなく計画の形で書く（CI で揺れないため）: 索引名を含み、`subject_id` が
 * Index Cond（または Recheck Cond）に入り、`Seq Scan on memories` を含まない。
 * `subjectId` が文字列のときと `null` のとき（`subject_id IS NULL` で索引を引く）の両方を見る。
 */

const TENANT = "claim-key-index";
const ROWS = 20_000;
const SUBJECTS = 20;

async function seed(pool: Pool): Promise<MemoryId> {
  const ids = Array.from({ length: ROWS }, () => randomUUID());
  // 3行に1行が claim key を持つ。subject は 's0'..'s19'、ただし i % 20 = 0 の行は subject なし。
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
  // Issue #933 案2（ADR 0378）: `findContestedByClaimKey` の EXPLAIN も見るため、`contested`
  // な行も同じ分布（claim key・subject）で作る。`idx_memories_contested`
  // （`(tenant_id, status) WHERE status = 'contested'`、0004）だけでは `subject_id`/
  // `claim_key_*` を絞れないので、`contested` の行数がある程度無いと、プランナが
  // `idx_memories_claim_key` より `idx_memories_contested` を安く見積もることがある
  // （0行なら後者はほぼ即座に空を返せるため）——実運用に近い分布にする。
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
  // 統計が無いと、プランナが誤った見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts / contested-with-index.test.ts と同じ勘所）。
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
    // 0029 の `idx_memories_claim_predicates`（`status = 'active'` の部分索引）も、`findActiveByClaimKey` の
    // 等値条件を `subject_id` まで Index Cond に使えるので、プランナがそちらを選ぶことがある（実測）。
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
    // 0029 が専用の部分索引 `idx_memories_claim_predicates` を足した。どちらの索引でも `subject_id` まで
    // 索引の条件に使えていればよい（どちらが選ばれるかは専用の歯 `claim-predicates-index.postgres.test.ts` が見る）。
    expect(text).toMatch(/idx_memories_claim_(key|predicates)/);
    expect(text).not.toContain("Seq Scan on memories");
    expect(text).toMatch(/(Index|Recheck) Cond: [^\n]*subject_id/);
  });
});
