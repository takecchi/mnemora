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
 * [ADR 0384](../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)（案A）:
 * `migrations/0028_digest_band_index.sql` が足した部分索引
 * `idx_memories_digest_band (tenant_id, COALESCE(occurred_at, recorded_at) DESC, id DESC)
 * WHERE status IN ('active', 'contested')` を、`PostgresMemoryStore.aggregateScope` の
 * `digestBand` サブクエリ（目次帯・第3階）が実際に使うことを縛る。
 *
 * `recall-gate-index.test.ts` と同じ反省を踏まえた作り:
 * - 歯1（形）: `pg_index` から索引の列順・部分述語を catalog で読む。プランナを通さない。
 * - 歯2（本番の SQL が実際に使う）: `PostgresMemoryStore.aggregateScope` が実際に発行する
 *   SQL 文そのものを `captureClientQuery`/`explainCaptured`（`aggregate-scope-single-pass.postgres.test.ts`
 *   と同じ手法、ADR 0284）で捕まえて `EXPLAIN` し、計画にこの索引の名前が現れることを見る。
 *   `recall-gate-index.test.ts` の反省（「プランナがこの索引を選んだ」と「使える」は別）を
 *   踏まえ、ここでは**強制なし・自然な計画**で索引名が現れることまでを主張する——
 *   `digestBandColumns` の SQL は `tenant_id` の等値と部分述語に一致する述語しか持たない
 *   条件（`occurredAfter`/`occurredBefore`/`validAt`/`labels` 未指定）で呼ぶため、
 *   この索引以外の経路が選ばれる理由が無い。
 * - 歯3（同値）: 索引を使う自然な計画と、索引経路を全部外した seq scan 強制の計画が、
 *   同じ digest の集合（順序込み）を返すこと。
 *
 * 変異試験（赤→緑の確認、PR 本文参照）: `migrations/0028_digest_band_index.sql` の
 * `WHERE status IN ('active', 'contested')` を落とす／列順を入れ替えると、歯1・歯2が
 * 赤くなることを手で確認した。
 */

const TENANT = "digest-band-index-tenant";
const ROW_COUNT = 20_000;

async function seed(pool: Pool): Promise<void> {
  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      'subject-' || (gs % 200),
      'digest-band-index memory #' || gs,
      md5('digest-band-index-content-' || gs::text),
      'digest-band-index digest #' || gs,
      'llm',
      'imported',
      '{"kind":"imported"}'::jsonb,
      (ARRAY['active','active','active','active','contested','archived','superseded','forgotten'])
        [1 + floor(random() * 8)::int],
      '{}'::text[],
      now() - (random() * interval '365 days'),
      now() - (random() * interval '365 days'),
      1.0,
      720,
      now() + interval '30 days',
      'ready',
      now(),
      now()
    FROM generate_series(1, $2) AS gs
    `,
    [TENANT, ROW_COUNT],
  );
  // 「列を絞らない」ANALYZE（recall-gate-index.test.ts と同じ作法。統計が無いと
  // プランナが誤った索引・Seq Scan を選び、この歯が実装と無関係な理由で赤/緑になる）。
  await pool.query("ANALYZE memories");
}

describe("idx_memories_digest_band（ADR 0384 案A）", () => {
  beforeAll(async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    await seed(pool);
  }, 60_000);

  afterAll(async () => {
    await closeTestClient();
  });

  it("形: idx_memories_digest_band は (tenant_id, COALESCE(occurred_at, recorded_at) DESC, id DESC) の3キーで、部分述語は active と contested のちょうど2値", async () => {
    const { pool } = await getTestClient();
    const shape = await pool.query<{
      natts: number;
      is_partial: boolean;
      pred_expr: string | null;
      is_valid: boolean;
      indexdef: string;
    }>(
      `SELECT
         i.indnatts AS natts,
         i.indpred IS NOT NULL AS is_partial,
         pg_get_expr(i.indpred, i.indrelid) AS pred_expr,
         i.indisvalid AS is_valid,
         pg_get_indexdef(i.indexrelid) AS indexdef
       FROM pg_index i
       WHERE i.indexrelid = 'idx_memories_digest_band'::regclass`,
    );

    expect(shape.rows).toHaveLength(1);
    const row = shape.rows[0]!;
    expect(row.natts).toBe(3);
    expect(row.is_valid).toBe(true);
    expect(row.is_partial).toBe(true);

    const pred = row.pred_expr ?? "";
    const literals = [...pred.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(literals)].sort(), pred).toEqual(["active", "contested"]);

    // 式索引の列順（tenant_id → eff_time DESC → id DESC）そのもの。indexdef の文字列で見る
    // （式索引の列は pg_attribute に現れないため、recall-gate-index.test.ts の
    // indkey/attname のやり方が使えない——ここでは DDL の再構成を読む）。
    expect(row.indexdef).toContain("tenant_id");
    expect(row.indexdef).toContain("COALESCE(occurred_at, recorded_at) DESC");
    expect(row.indexdef).toMatch(/id DESC\)?\s*(WHERE|$)/);
  });

  it("本番の SQL: aggregateScope の digestBand サブクエリが、強制なしの自然な計画で idx_memories_digest_band を使う", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const captured = await captureClientQuery(
      (text) => text.includes("FROM memories") && text.includes("digest_eligible_count"),
      () =>
        memoryStore.aggregateScope(ctx, {}, { digestBand: { limit: 50, excludeMemoryIds: [] } }),
    );
    const plan = await explainCaptured(pool, captured, "ANALYZE, BUFFERS, FORMAT TEXT");
    console.log(`=== EXPLAIN（aggregateScope の digestBand、強制なし）===\n${plan}`);

    expect(plan, plan).toContain("idx_memories_digest_band");
    // digests サブクエリ側（InitPlan 1）が Index Scan になっていること。
    // ⚠ 本体側（外側の HashAggregate、`GROUP BY subject_id` の件数集計）は今も
    // `Seq Scan on memories` のまま——これは ADR 0307「採らなかった案」1番・
    // ADR 0384「採らなかった案」（案B/事前カウンタ表）が説明するとおり、この索引の
    // 対象外（支配項は GROUP BY 本体であって digestBand ではない）。この歯が縛るのは
    // digestBand 側だけである。
    const initPlan1 = plan.slice(0, plan.indexOf("InitPlan 2"));
    expect(initPlan1, initPlan1).toContain("Index Scan using idx_memories_digest_band");
    expect(initPlan1, initPlan1).not.toMatch(/Seq Scan/);
  });

  it("同値: 索引を使う自然な計画と seq scan を強制した計画が、同じ digest の集合を順序込みで返す", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const natural = await memoryStore.aggregateScope(
      ctx,
      {},
      { digestBand: { limit: 50, excludeMemoryIds: [] } },
    );

    const client = await pool.connect();
    let forcedIds: string[];
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_indexonlyscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const result = await client.query<{ id: string }>(
        `SELECT id
         FROM memories
         WHERE tenant_id = $1
           AND status IN ('active', 'contested')
         ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC
         LIMIT 50`,
        [TENANT],
      );
      forcedIds = result.rows.map((r) => r.id);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    expect(natural.digests.map((d) => d.memoryId)).toEqual(forcedIds);
    expect(natural.digests.length).toBe(50);
  });
});
