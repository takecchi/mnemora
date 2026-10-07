import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `PostgresMemoryStore.purgeMemory` が `recalls.index_band` の目次帯を書き換える `UPDATE` の `WHERE` 句が、
 * `migrations/0030_recalls_digest_band_index.sql` の式 GIN 索引 `idx_recalls_digest_band` を使うことを縛る。
 * 索引が無い（または式がずれて使えない）と、テナントの `recalls` を全部読む Seq Scan / `idx_recalls_by_subject` 経由の全行フィルタに戻る。
 *
 * ⚠ 専用の接続で `enable_seqscan = off` にする。planner の見積もりの揺れに左右されないため。
 * 索引が無ければ、この設定でも `idx_recalls_by_subject`（`tenant_id` 先頭）へ倒れるだけで `idx_recalls_digest_band` は使えない
 * （索引を抜く・式を変える変異でこの歯は赤になる）。
 */

afterAll(async () => {
  await closeTestClient();
});

const INDEX = "idx_recalls_digest_band";
const TARGET = "11111111-1111-4111-8111-111111111111";

async function seedRecalls(tenantId: string, rows: number): Promise<void> {
  const { pool } = await getTestClient();
  // 1% の行が TARGET を目次帯に載せている。
  await pool.query(
    `INSERT INTO recalls (tenant_id, subject_id, query, usage, index_band, explain, returned_memories)
     SELECT $1, 'subj' || (g % 50), '{"text":"q"}'::jsonb, '{}'::jsonb,
       jsonb_build_object('digestBand', (
         SELECT jsonb_agg(jsonb_build_object(
           'memoryId', CASE WHEN g % 100 = 0 AND k = 1 THEN $2::text
                            ELSE md5(g::text || ':' || k)::uuid::text END,
           'digest', '要約 ' || g || '-' || k))
         FROM generate_series(1, 5) k)),
       '{}'::jsonb, '[]'::jsonb
     FROM generate_series(1, $3::int) g`,
    [tenantId, TARGET, rows],
  );
  await pool.query("ANALYZE recalls");
}

describe("recalls.index_band の digestBand の書き換えは、式 GIN 索引を使う（ADR 0389）", () => {
  it("purgeMemory の UPDATE と同じ述語の EXPLAIN が idx_recalls_digest_band を使う", async () => {
    await resetTestDatabase();
    const tenantId = `recalls-digest-band-explain-${randomUUID()}`;
    await seedRecalls(tenantId, 20_000);

    const client = createPostgresClient(requireDatabaseUrl(), {
      options: "-c enable_seqscan=off",
      max: 1,
    });
    try {
      const { rows } = await client.pool.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF)
         UPDATE recalls SET index_band = index_band
         WHERE tenant_id = $1
           AND index_band ? 'digestBand'
           AND index_band->'digestBand' @> jsonb_build_array(jsonb_build_object('memoryId', $2::text))`,
        [tenantId, TARGET],
      );
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan, plan).toContain(INDEX);
    } finally {
      await closePostgresClient(client).catch(() => {});
    }
  }, 60_000);

  it("実際の purgeMemory が idx_recalls_digest_band の idx_scan を増やし、該当エントリだけを伏せる", async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    const tenantId = `recalls-digest-band-purge-${randomUUID()}`;
    await seedRecalls(tenantId, 20_000);

    // 対象の Memory（forgotten でないと purgeMemory は受け付けない）。id は TARGET に揃える。
    await pool.query(
      `INSERT INTO memories (
         id, tenant_id, subject_id, source_observation_id, extractor_version,
         content, content_hash, digest, digest_source, provenance_kind, provenance,
         status, tags, recorded_at, strength, half_life_hours, decay_floor_at,
         embedding_status, created_at, updated_at
       ) VALUES (
         $2, $1, NULL, NULL, NULL,
         'c', 'c', 'c', 'llm', 'imported',
         '{"kind":"imported","batchId":"digest-band-index"}'::jsonb,
         'forgotten', '{}', now(), 1.0, 720, now() + interval '180 days',
         'pending', now(), now()
       )`,
      [tenantId, TARGET],
    );

    const client = createPostgresClient(requireDatabaseUrl(), {
      options: "-c enable_seqscan=off",
      max: 1,
    });
    try {
      const readIdxScan = async (): Promise<number> => {
        await client.pool.query("SELECT pg_stat_force_next_flush()");
        await client.pool.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await client.pool.query<{ idx_scan: string }>(
          "SELECT idx_scan::text FROM pg_stat_user_indexes WHERE indexrelname = $1",
          [INDEX],
        );
        // 索引が無ければ、ここで名指しで落ちる（行が返らない）。
        expect(rows.map((r) => r.idx_scan).length, `${INDEX} が無い`).toBe(1);
        return Number(rows[0]!.idx_scan);
      };
      const before = await readIdxScan();

      const store = new PostgresMemoryStore(client.db);
      await store.purgeMemory(
        { tenantId },
        TARGET,
        { content: "[purged]", digest: "[purged]" },
        { tenantId, memoryId: TARGET, kind: "purged", actor: { type: "system" }, meta: {} },
      );

      const after = await readIdxScan();
      expect(after, `idx_scan: before=${before} after=${after}`).toBeGreaterThan(before);

      const { rows } = await pool.query<{ n: string; tomb: string }>(
        `SELECT count(*) FILTER (WHERE index_band->'digestBand' @> jsonb_build_array(jsonb_build_object('memoryId', $2::text))) AS n,
                count(*) FILTER (WHERE index_band->'digestBand'->0->>'digest' = '[purged]') AS tomb
         FROM recalls WHERE tenant_id = $1`,
        [tenantId, TARGET],
      );
      expect(Number(rows[0]!.n)).toBe(200);
      expect(Number(rows[0]!.tomb)).toBe(200);
    } finally {
      await closePostgresClient(client).catch(() => {});
    }
  }, 60_000);
});
