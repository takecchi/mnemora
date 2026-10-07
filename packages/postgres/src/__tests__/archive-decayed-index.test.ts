import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildArchiveDecayedTargetSelect, PostgresMemoryStore } from "../memory-store.js";
import * as schema from "../schema.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `buildArchiveDecayedTargetSelect` が、新しい索引を追加せずに既存の `idx_memories_recall_gate` だけで適用可能であることを確かめる。
 *
 * - 本体の関数の返り値をそのまま `EXPLAIN`/実行する。述語をテスト側に書き写さない。
 * - 「選ばれること」ではなく「選べること」を測る。seq scan と bitmap scan をプランナから外し、
 *   コスト比較という揺れる軸を外して、索引が述語に使えるかだけを見る。本番で実際に選ばれることは保証しない。
 *
 * ⚠ `SET LOCAL enable_seqscan = off` 等のプランナ強制は `pool` から取り出した特定の `PoolClient` の上でしか効かない
 * （`pool.query()` も `getTestClient()` の `db` も呼ぶたびに違う接続を借りうる）。
 * そのため `drizzle(client, { schema })` で強制を掛けたその `PoolClient` 自身に束ねた一時的な `Db` を作り、
 * `target` をその上で実行する。
 */

const TENANT = "archive-decayed-index-tenant";

/**
 * 大量行・現実に近い分布でないとプランナが「行数が少ないのでどうせ Seq Scan」を選び、含意の検査にならない。
 * `active` を大半にし、掃引の対象外になる status を少数混ぜる。
 */
const ROW_COUNT = 20_000;

/**
 * 活動時計側の `decay_base_seq`/`decay_floor_seq`/`half_life_recalls` も同じ seed で populate する。
 * `decay_floor_seq` は `decay_floor_at` と同じく半分が沈み半分が沈まない分布
 * （`i` が偶数なら `i` 自身、奇数なら `NOW_SEQ` よりずっと大きい値）。
 */
async function seedManyMemories(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      last_reinforced_at, strength, half_life_hours, decay_floor_at,
      decay_base_seq, decay_floor_seq, half_life_recalls,
      embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      NULL,
      'seed content ' || i,
      'archive-decayed-index-seed-' || i,
      'seed digest ' || i,
      'llm',
      'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      -- 大半を 'active'（掃引の対象）にし、'contested'（索引の述語には入るが対象外）・
      -- 'archived'/'superseded'/'forgotten'（索引の述語からも対象からも外れる）を少量混ぜる。
      CASE
        WHEN i % 100 = 0 THEN 'contested'
        WHEN i % 100 = 1 THEN 'archived'
        WHEN i % 100 = 2 THEN 'superseded'
        WHEN i % 100 = 3 THEN 'forgotten'
        ELSE 'active'
      END,
      '{}',
      NULL,
      now() - (i || ' seconds')::interval,
      NULL,
      1.0,
      720,
      -- decay_floor_at: 半分は既に閾値を割っている（過去）、半分はまだ（未来）。
      CASE WHEN i % 2 = 0 THEN now() - (i || ' seconds')::interval ELSE now() + (i || ' seconds')::interval END,
      0,
      -- decay_floor_seq: 同じ「半分は沈んでいる・半分はまだ」の分布を数直線で作る
      -- (nowSeq（= rowCount）より小さければ沈んでいる)。
      CASE WHEN i % 2 = 0 THEN i ELSE $2::bigint * 10 + i END,
      720,
      'ready',
      now() - (i || ' seconds')::interval,
      now() - (i || ' seconds')::interval
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ。
  await pool.query("ANALYZE memories");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

const CTX: Ctx = { tenantId: TENANT };
/** `now` は seed の中央（`ROW_COUNT / 2` 秒前）に置く——過去・未来の両方が実在する。 */
const NOW = new Date();
const OPTS = { now: NOW, limit: 50 };

/**
 * `nowSeq = ROW_COUNT` は `seedManyMemories` の `decay_floor_seq` 分布の境界と一致する。
 * 偶数側だけが `decay_floor_seq <= nowSeq` を満たす。
 */
const OPTS_ACTIVITY = { now: NOW, nowSeq: ROW_COUNT, limit: 50, clock: "activity" as const };

type Forcing = "none" | "btreeIndex" | "seqscan";

/**
 * **`release()` を `ROLLBACK` の外側に置く**——`ROLLBACK` が投げると `release()` に到達せず、
 * その接続がプールへ戻らないまま失われる。
 */
async function withForcing<T>(
  pool: Pool,
  forcing: Forcing,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (forcing === "btreeIndex") {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    } else if (forcing === "seqscan") {
      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_indexonlyscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    }
    return await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function explainTarget(
  pool: Pool,
  forcing: Forcing,
  opts: Parameters<typeof buildArchiveDecayedTargetSelect>[1] = OPTS,
): Promise<string> {
  return withForcing(pool, forcing, async (client) => {
    const dbOnClient = drizzle(client, { schema });
    const target = buildArchiveDecayedTargetSelect(CTX, opts);
    const result = await dbOnClient.execute(sql`EXPLAIN (FORMAT TEXT) ${target}`);
    return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
  });
}

async function targetRowIds(
  pool: Pool,
  forcing: Forcing,
  opts: Parameters<typeof buildArchiveDecayedTargetSelect>[1] = OPTS,
): Promise<string[]> {
  return withForcing(pool, forcing, async (client) => {
    const dbOnClient = drizzle(client, { schema });
    const target = buildArchiveDecayedTargetSelect(CTX, opts);
    const result = await dbOnClient.execute(target);
    return (result.rows as unknown as { id: string }[]).map((row) => row.id);
  });
}

describe("archiveDecayed の対象選択索引（ADR 0114）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("適用可能性: btree 経路だけに絞ると、archiveDecayed の対象選択が idx_memories_recall_gate を引ける（新しい索引を追加しない）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const naturalPlan = await explainTarget(pool, "none");
    console.log(`=== EXPLAIN（自然な計画・強制なし。assert しない観測）===\n${naturalPlan}`);

    const forcedPlan = await explainTarget(pool, "btreeIndex");
    console.log(
      `=== EXPLAIN（enable_seqscan = off, enable_bitmapscan = off。この歯が assert する計画）===\n${forcedPlan}`,
    );

    expect(forcedPlan, forcedPlan).toContain("idx_memories_recall_gate");
    expect(forcedPlan, forcedPlan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  it("同値: 自然な計画・btree を強制した計画・全走査を強制した計画が、同じ行集合を返す（active かつ decay_floor_at <= now のみ）", async () => {
    const { pool, db } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const natural = await targetRowIds(pool, "none");
    const viaBtree = await targetRowIds(pool, "btreeIndex");
    const viaSeqScan = await targetRowIds(pool, "seqscan");

    expect(new Set(viaBtree)).toEqual(new Set(viaSeqScan));
    expect(new Set(natural)).toEqual(new Set(viaSeqScan));
    // 集合としての一致（「同じ行を落としていない」）だけを見る。順序は下の別の歯で見る。
    expect(natural.length).toBeGreaterThan(0);
    expect(natural.length).toBeLessThanOrEqual(OPTS.limit);

    // 索引の話とデータの話の両方を検査する（「索引はあるが述語を書き間違えて何も拾えていない」を見逃さないため）。
    const store = new PostgresMemoryStore(db);
    const idSet = new Set(natural);
    let sawActive = false;
    for (const id of idSet) {
      const memory = await store.get(CTX, id);
      expect(memory?.status).toBe("active");
      expect(memory && memory.decayFloorAt.getTime() <= NOW.getTime()).toBe(true);
      sawActive = true;
    }
    expect(sawActive).toBe(true);
  }, 60_000);

  it("適用可能性（活動時計）: btree 経路だけに絞ると、clock: 'activity' の対象選択が idx_memories_recall_gate_seq を引ける", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const naturalPlan = await explainTarget(pool, "none", OPTS_ACTIVITY);
    console.log(
      `=== EXPLAIN 活動時計（自然な計画・強制なし。assert しない観測）===\n${naturalPlan}`,
    );

    const forcedPlan = await explainTarget(pool, "btreeIndex", OPTS_ACTIVITY);
    console.log(
      `=== EXPLAIN 活動時計（enable_seqscan = off, enable_bitmapscan = off。この歯が assert する計画）===\n${forcedPlan}`,
    );

    expect(forcedPlan, forcedPlan).toContain("idx_memories_recall_gate_seq");
    expect(forcedPlan, forcedPlan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  it("同値（活動時計）: 自然な計画・btree を強制した計画・全走査を強制した計画が、同じ行集合を返す（active かつ decay_floor_seq <= nowSeq のみ）", async () => {
    const { pool, db } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const natural = await targetRowIds(pool, "none", OPTS_ACTIVITY);
    const viaBtree = await targetRowIds(pool, "btreeIndex", OPTS_ACTIVITY);
    const viaSeqScan = await targetRowIds(pool, "seqscan", OPTS_ACTIVITY);

    expect(new Set(viaBtree)).toEqual(new Set(viaSeqScan));
    expect(new Set(natural)).toEqual(new Set(viaSeqScan));
    expect(natural.length).toBeGreaterThan(0);
    expect(natural.length).toBeLessThanOrEqual(OPTS_ACTIVITY.limit);

    const store = new PostgresMemoryStore(db);
    const idSet = new Set(natural);
    let sawActive = false;
    for (const id of idSet) {
      const memory = await store.get(CTX, id);
      expect(memory?.status).toBe("active");
      expect(memory?.decayFloorSeq).not.toBeNull();
      expect((memory?.decayFloorSeq as number) <= OPTS_ACTIVITY.nowSeq).toBe(true);
      sawActive = true;
    }
    expect(sawActive).toBe(true);
  }, 60_000);
});
