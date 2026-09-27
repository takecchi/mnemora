import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, ObservationId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  captureClientQuery,
  closeTestClient,
  explainCaptured,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * EXPLAIN の歯がまだ無かった2本の索引を、実際に打たれる SQL で縛る。
 *
 * - `idx_memories_superseded_by`（`(tenant_id, superseded_by_id) WHERE superseded_by_id IS NOT NULL`）:
 *   `restoreSuperseded` の群の選び出し（`restoreSupersededBy?` と `previewRestoreSupersededBy?` の
 *   `target` CTE。`onlyMemoryIds` を渡さない既定の形）
 * - `uq_memories_extraction`（`(tenant_id, source_observation_id, extractor_version, content_hash)`）:
 *   `reextract` が既存の抽出結果を探す `listBySourceObservation`
 *
 * 【実測 2026-09-27、main 44b9326、1テナント 20,000 行 + 別テナント 5,000 行、ANALYZE 済み】
 * どちらも索引を使っていた。期待値は時間ではなく計画の形で書く（CI で揺れないため）:
 * 索引名を含み、`Seq Scan on memories` を含まない。
 */

const TENANT = "superseded-and-extraction-index";
const ROWS = 20_000;

async function seed(pool: Pool): Promise<{ superseder: MemoryId; observationId: ObservationId }> {
  const observationIds = Array.from({ length: ROWS / 4 }, () => randomUUID());
  await pool.query(
    `INSERT INTO observations (id, tenant_id, kind, payload, recorded_at)
     SELECT o, $2, 'utterance', '{"text":"x"}'::jsonb, now() FROM unnest($1::uuid[]) AS o`,
    [observationIds, TENANT],
  );
  const ids = Array.from({ length: ROWS }, () => randomUUID());
  await pool.query(
    `INSERT INTO memories (id, tenant_id, source_observation_id, extractor_version, content, content_hash,
        digest, digest_source, provenance_kind, provenance, status, tags, recorded_at, strength,
        half_life_hours, decay_floor_at, embedding_status, created_at, updated_at)
     SELECT m, $2, ($3::uuid[])[(i % $4) + 1], 'v1', 'c ' || m, md5(m::text), 'd', 'llm',
        'stated', jsonb_build_object('kind', 'stated', 'observationId', ($3::uuid[])[(i % $4) + 1]),
        'active', '{}'::text[], now(), 1, 720, now() + interval '30 days', 'ready', now(), now()
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(m, i)`,
    [ids, TENANT, observationIds, observationIds.length],
  );
  // 先頭の 50 行を統合先とし、次の 2,000 行をそれらの superseded にする（1群あたり約40行）。
  await pool.query(
    `UPDATE memories SET status = 'superseded', superseded_by_id = ($1::uuid[])[(r.rank % 50) + 1]
     FROM (SELECT id AS target_id, row_number() OVER (ORDER BY id) AS rank
           FROM memories WHERE tenant_id = $2 AND NOT (id = ANY($1::uuid[])) LIMIT 2000) r
     WHERE id = r.target_id`,
    [ids.slice(0, 50), TENANT],
  );
  const other = Array.from({ length: 5_000 }, () => randomUUID());
  await pool.query(
    `INSERT INTO memories (id, tenant_id, content, content_hash, digest, digest_source, provenance_kind,
        provenance, status, tags, recorded_at, strength, half_life_hours, decay_floor_at,
        embedding_status, created_at, updated_at)
     SELECT m, 'superseded-and-extraction-index-other', 'c', md5(m::text), 'd', 'llm', 'imported',
        '{"kind":"imported"}'::jsonb, 'active', '{}'::text[], now(), 1, 720,
        now() + interval '30 days', 'ready', now(), now()
     FROM unnest($1::uuid[]) AS m`,
    [other],
  );
  // 統計が無いと、プランナが誤った見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts / contested-with-index.test.ts と同じ勘所）。
  await pool.query("ANALYZE memories");
  await pool.query("ANALYZE observations");
  return { superseder: ids[0]! as MemoryId, observationId: observationIds[7]! as ObservationId };
}

describe("idx_memories_superseded_by / uq_memories_extraction を使う（Seq Scan にしない）", () => {
  let store: PostgresMemoryStore;
  let pool: Pool;
  let seeded: { superseder: MemoryId; observationId: ObservationId };
  const ctx: Ctx = { tenantId: TENANT };

  beforeAll(async () => {
    await resetTestDatabase();
    const client = await getTestClient();
    pool = client.pool;
    store = new PostgresMemoryStore(client.db);
    seeded = await seed(pool);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function plan(matcher: (text: string) => boolean, fn: () => Promise<unknown>) {
    return explainCaptured(pool, await captureClientQuery(matcher, fn));
  }

  it("previewRestoreSupersededBy（restoreSuperseded の dryRun）の群の選び出し", async () => {
    const text = await plan(
      (t) => /latest_superseded_event/.test(t),
      () => store.previewRestoreSupersededBy(ctx, seeded.superseder),
    );
    expect(text).toContain("idx_memories_superseded_by");
    expect(text).not.toContain("Seq Scan on memories");
  });

  it("restoreSupersededBy（onlyMemoryIds を渡さない既定の形）の群の選び出し", async () => {
    const text = await plan(
      (t) => /restored AS/.test(t),
      () => store.restoreSupersededBy(ctx, seeded.superseder, { at: new Date() }),
    );
    expect(text).toContain("idx_memories_superseded_by");
    expect(text).not.toContain("Seq Scan on memories");
  });

  it("listBySourceObservation（reextract が既存の抽出結果を探す）", async () => {
    const text = await plan(
      (t) => /source_observation_id\s*=/.test(t) && /extractor_version/.test(t),
      () => store.listBySourceObservation(ctx, seeded.observationId, "v1"),
    );
    expect(text).toContain("uq_memories_extraction");
    expect(text).not.toContain("Seq Scan on memories");
  });
});
