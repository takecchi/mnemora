import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * - 索引の定義を文字列で見るのは、計画が索引を選ぶかどうかでは、演算子クラス（`jsonb_ops` は
 *   `@>` にも使える）や先頭に足した `tenant_id`（複合でも `@>` の述語で選ばれる）の違いが見えないため。
 *   どちらも結果は同じで、索引が大きく書き込みが重くなるだけなので、定義そのものを縛る。
 * - 墓石の `content` と `digest` に別の値を渡すのは、同じ値だと取り違えても結果が同じになるため。
 */

const INDEX = "idx_recalls_digest_band";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

describe("idx_recalls_digest_band の定義", () => {
  it("(index_band->'digestBand') の jsonb_path_ops の GIN 索引で、tenant_id も WHERE も持たない", async () => {
    const { pool } = await getTestClient();
    const { rows } = await pool.query<{ def: string }>(
      "SELECT indexdef AS def FROM pg_indexes WHERE indexname = $1",
      [INDEX],
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.def;
    expect(def).toMatch(/USING gin \(\(\(index_band -> 'digestBand'::text\)\) jsonb_path_ops\)$/);
    expect(def).not.toContain("tenant_id");
    expect(def).not.toContain("WHERE");
  });
});

describe("purgeMemory が目次帯に書く値", () => {
  it("該当エントリの digest は墓石の digest（content ではない）になり、ほかのエントリは変わらない", async () => {
    const { db, pool } = await getTestClient();
    const tenantId = `recalls-digest-band-edges-${randomUUID()}`;
    await pool.query(
      `INSERT INTO recalls (tenant_id, subject_id, query, usage, index_band, explain, returned_memories)
       VALUES ($1, NULL, '{"text":"q"}'::jsonb, '{}'::jsonb,
         jsonb_build_object('digestBand', jsonb_build_array(
           jsonb_build_object('memoryId', $2::text, 'digest', 'secret'),
           jsonb_build_object('memoryId', $3::text, 'digest', 'keep'))),
         '{}'::jsonb, '[]'::jsonb)`,
      [tenantId, TARGET, OTHER],
    );
    await pool.query(
      `INSERT INTO memories (
         id, tenant_id, subject_id, source_observation_id, extractor_version,
         content, content_hash, digest, digest_source, provenance_kind, provenance,
         status, tags, recorded_at, strength, half_life_hours, decay_floor_at,
         embedding_status, created_at, updated_at
       ) VALUES (
         $2, $1, NULL, NULL, NULL,
         'c', 'c', 'c', 'llm', 'imported',
         '{"kind":"imported","batchId":"digest-band-edges"}'::jsonb,
         'forgotten', '{}', now(), 1.0, 720, now() + interval '180 days',
         'pending', now(), now()
       )`,
      [tenantId, TARGET],
    );

    await new PostgresMemoryStore(db).purgeMemory(
      { tenantId },
      TARGET,
      { content: "[content-tombstone]", digest: "[digest-tombstone]" },
      { tenantId, memoryId: TARGET, kind: "purged", actor: { type: "system" }, meta: {} },
    );

    const { rows } = await pool.query<{ band: unknown }>(
      "SELECT index_band->'digestBand' AS band FROM recalls WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows[0]!.band).toEqual([
      { memoryId: TARGET, digest: "[digest-tombstone]" },
      { memoryId: OTHER, digest: "keep" },
    ]);
  });
});
