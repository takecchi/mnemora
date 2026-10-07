import { afterAll, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ⚠ EXPLAIN では測れない。参照整合性チェックはトリガの中で打たれる問い合わせで、`EXPLAIN ANALYZE DELETE ...` はトリガの時間と回数しか返さず、
 * その中の計画は見せない。代わりに、索引ごとの使用回数 `pg_stat_user_indexes.idx_scan` が削除の前後で増えることを見る。
 *
 * ⚠ 専用の接続で `enable_seqscan = off` にする。テストの表は小さく、そのままではプランナーは全件走査を選ぶ。
 * 既存の `(tenant_id, from_memory_id, kind)` 索引は先頭が `tenant_id` なので、同じ設定でもこの問い合わせには1点で引けない。
 */

afterAll(async () => {
  await closeTestClient();
});

const INDEXES = ["idx_memory_relations_from_memory_id", "idx_memory_relations_to_memory_id"];

describe("memory_relations の外部キーの検査は、単一列索引を使う（Issue #1207 / ADR 0383）", () => {
  it("memories の行を消すと、idx_memory_relations_from_memory_id / _to_memory_id の idx_scan が増える", async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    const tenantId = "erase-tenant-ri-index";

    const insertMemory = async (label: string): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO memories (
           id, tenant_id, subject_id, source_observation_id, extractor_version,
           content, content_hash, digest, digest_source, provenance_kind, provenance,
           status, tags, recorded_at, strength, half_life_hours, decay_floor_at,
           embedding_status, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, NULL, NULL, NULL,
           $2, $2, $2, 'llm', 'imported',
           '{"kind":"imported","batchId":"ri-index"}'::jsonb,
           'active', '{}', now(), 1.0, 720, now() + interval '180 days',
           'pending', now(), now()
         ) RETURNING id`,
        [tenantId, label],
      );
      return rows[0]!.id;
    };
    // victim 自身は関係を持たない（参照している行があると削除が外部キー違反で落ちるので、検査は「空振り」させる）。
    const victim = await insertMemory("victim");
    const a = await insertMemory("a");
    const b = await insertMemory("b");
    await pool.query(
      `INSERT INTO memory_relations (tenant_id, from_memory_id, to_memory_id, kind)
       VALUES ($1, $2, $3, 'contradicts'), ($1, $3, $2, 'contradicts')`,
      [tenantId, a, b],
    );

    const client = createPostgresClient(requireDatabaseUrl(), {
      options: "-c enable_seqscan=off",
      max: 1,
    });
    try {
      const readIdxScan = async (): Promise<Record<string, number>> => {
        await client.pool.query("SELECT pg_stat_force_next_flush()");
        await client.pool.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await client.pool.query<{ indexrelname: string; idx_scan: string }>(
          `SELECT indexrelname, idx_scan::text FROM pg_stat_user_indexes
           WHERE indexrelname = ANY($1::text[])`,
          [INDEXES],
        );
        const out: Record<string, number> = {};
        for (const r of rows) {
          out[r.indexrelname] = Number(r.idx_scan);
        }
        return out;
      };

      const before = await readIdxScan();
      expect(Object.keys(before).sort()).toEqual([...INDEXES].sort());

      await client.pool.query("DELETE FROM memories WHERE id = $1", [victim]);

      const after = await readIdxScan();
      for (const index of INDEXES) {
        expect(
          { index, increased: after[index]! > before[index]! },
          `idx_scan: before=${before[index]} after=${after[index]}`,
        ).toEqual({ index, increased: true });
      }
    } finally {
      await closePostgresClient(client).catch(() => {});
    }
  }, 60_000);
});
