import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { buildRequeueEmbedTargetSelect } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 「前」の測定のために落とした索引を作り直すための DDL。マイグレーションファイルからそのまま読む（書き写すと、migration を直したときにこの復元だけが古い定義のまま静かにずれる）。 */
const MIGRATION_0007_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0007_memories_requeue_embed_index.sql"),
  "utf8",
);

/**
 * `buildRequeueEmbedTargetSelect` の返り値をそのまま `EXPLAIN` する（テスト側に述語を書き写さない）。
 * 前 = 索引が無い世界で `ORDER BY updated_at, id LIMIT n` に `Sort` が挟まる（`LIMIT` の早期打ち切りが効かない）こと、
 * 後 = 索引が在る世界で `Sort` が消えることを確認する。
 * すべて `console.log` で全文を出力する。「索引が使われる/使われない」を出力そのもので示すための意図的な出力で、削らないこと。
 * `EXPLAIN`（`ANALYZE` を付けない）はプランを組み立てるだけでクエリを実行しないので、`FOR UPDATE SKIP LOCKED` を含む `SELECT` でも安全にプランだけ取れる。
 */

const TENANT = "memories-requeue-embed-tenant";
// btree の partial index をシーケンシャルスキャンより優先させるため、行数を多めに用意する。
const ROW_COUNT = 20_000;

/** 大半の Memory が `ready` に達している定常状態に近づけるため、95% を `ready`、残り5%を `failed`/`pending` に半々で散らす。`status` も大半を `active` にする。 */
async function seedManyMemories(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      last_reinforced_at, strength, half_life_hours, decay_floor_at,
      embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      NULL,
      'seed content ' || i,
      'seed-content-hash-' || i,
      'seed digest ' || i,
      'llm',
      'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      -- status: 大半を 'active' にする。1% を 'contested'（部分索引の対象に含まれる）、
      -- 1% を 'archived'（部分索引の対象から外れる。索引の選択性を現実的にするため
      -- 対象外の status も少量混ぜる）にする。
      CASE
        WHEN i % 100 = 0 THEN 'contested'
        WHEN i % 100 = 1 THEN 'archived'
        ELSE 'active'
      END,
      '{}',
      NULL,
      now() - (i || ' seconds')::interval,
      NULL,
      1.0,
      720,
      now() + interval '30 days',
      -- embedding_status: 95% を 'ready'、5% を 'failed'/'pending' に半々で散らす
      -- （上のdocコメント参照）。
      CASE
        WHEN i % 20 != 0 THEN 'ready'
        WHEN i % 40 = 0 THEN 'failed'
        ELSE 'pending'
      END,
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
const OPTS = { statuses: ["failed", "pending"] as const, limit: 50 };

/** 本体が実際に打つ `SELECT` をそのまま `EXPLAIN` する。ここで述語を書き写すと、本体を直したときにこの歯だけが古い述語を測り続ける。 */
async function explainTargetSelect(): Promise<string> {
  const { db } = await getTestClient();
  const target = buildRequeueEmbedTargetSelect(CTX, { ...OPTS, statuses: [...OPTS.statuses] });
  if (target === null) {
    throw new Error("buildRequeueEmbedTargetSelect が null を返した（memoryIds を渡していない）");
  }
  const result = await db.execute(sql`EXPLAIN (FORMAT TEXT) ${target}`);
  return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
}

describe("memories の requeueEmbedJobs 索引（ADR 0079）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: idx_memories_requeue_embed が無い世界では Sort が挟まる（LIMIT の早期打ち切りが効かない）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    // 「前」の世界を作るため、migrate 済みの DB からこのテストの間だけ索引を落とす。
    // `resetTestDatabase()` はマイグレーション（索引を含むスキーマ）を再実行しないので、DROP したままだと後続のテストまで索引の無い状態を引きずる。必ず `finally` で元の定義を作り直す。
    await pool.query("DROP INDEX idx_memories_requeue_embed");
    try {
      const plan = await explainTargetSelect();
      console.log(`=== EXPLAIN（前: idx_memories_requeue_embed 無し）===\n${plan}`);

      // ⚠ `Seq Scan on memories` を assert しない。「前」の世界でプランナが Seq Scan か別の索引を選ぶかは統計次第で、測りたいのは `Sort` が挟まって `LIMIT` の早期打ち切りが効かないことそのものである。
      expect(plan).toContain("Sort");
    } finally {
      await pool.query(MIGRATION_0007_SQL);
    }
  }, 60_000);

  it("後: idx_memories_requeue_embed が実際に使われ、updated_at, id の全体ソートを索引が肩代わりする", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const plan = await explainTargetSelect();
    console.log(`=== EXPLAIN（後: idx_memories_requeue_embed 在り）===\n${plan}`);

    expect(plan).toContain("idx_memories_requeue_embed");
    // 「索引が使われている」だけでは足りず、`updated_at, id` の全体ソートを索引が肩代わりしていることを見る。
    // ⚠ `"Sort Key: memories.updated_at"` と書かないこと。PostgreSQL の EXPLAIN は単一テーブルの `Sort Key` に表名を前置しないので、表名つきで書くとこの assert は常に成立し、Sort が挟まっていても緑になる。
    expect(plan).not.toContain("Sort Key");
  }, 60_000);

  /**
   * 本体の `WHERE` に `AND embedding_status <> 'ready'` を冗長に書かない理由を、出力そのもので残す。
   * 書かなくても索引は選ばれる（プランナは `= ANY($n)` の実引数を定数として見るので、部分索引の述語が含意される）。
   * 書くと、その条件片が Recheck Cond に回って Bitmap Heap Scan が選ばれ、`ORDER BY` のために Sort が挟まって遅くなる。
   */
  it("⭐ embedding_status <> 'ready' を書き足すと、索引は使われるが Sort が挟まって遅くなる（当初の見立ての反証）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT id FROM memories
       WHERE tenant_id = $1
         AND status IN ('active', 'contested')
         AND embedding_status <> 'ready'
         AND embedding_status = ANY($2::text[])
       ORDER BY updated_at ASC, id ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [TENANT, ["failed", "pending"], 50],
    );
    const plan = planText(explainResult.rows as { "QUERY PLAN": string }[]);
    console.log(`=== EXPLAIN（<> 'ready' を書き足した述語。本体はこれを書かない）===\n${plan}`);

    expect(plan).toContain("idx_memories_requeue_embed");
    expect(plan).toContain("Sort Key");
  }, 60_000);
});
