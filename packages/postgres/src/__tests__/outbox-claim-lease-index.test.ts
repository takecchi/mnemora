import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0032 の実測（マネージャー指摘の帰結2を検査する）。
 *
 * `PostgresOutboxStore.claimBatch`（本PR以前）の `WHERE` は `claimed_at` に一切触れない。
 * 一方 `migrations/0001_init.sql` の `idx_outbox_pending` は
 * `WHERE completed_at IS NULL AND claimed_at IS NULL` という部分索引であり、この述語は
 * 「claim のリース」が話題に上る前は「読んでそう推論した」段階でしかなかった——
 * **部分索引の述語がクエリの WHERE から論理的に含意されない限り、プランナはその索引を
 * 使えない**、という Postgres の一般的な性質から導いた推論であり、このリポジトリの
 * `EXPLAIN` で実測されたことは無かった。
 *
 * このテストは:
 * 1. 「前」= 本PR以前の（`claimed_at` に触れない）`claimBatch` の述語を、実際の
 *    `claimBatch` と同じ SQL 構造（`WITH ... FOR UPDATE SKIP LOCKED` + `UPDATE`）で
 *    `EXPLAIN` し、`idx_outbox_pending` が使われていないことを確認する（帰結2の実測）。
 *    `EXPLAIN`（`ANALYZE` を付けない）はプランを組み立てるだけで実際にはクエリを実行
 *    しない——`UPDATE` 文を対象にしても安全にプランだけ取れる。
 * 2. 「後」= 本PR で足したリース条件（`claimed_at IS NULL OR claimed_at <= リース境界`）
 *    付きの述語を同じ構造で `EXPLAIN` し、本PRで新設した `idx_outbox_claimable`
 *    （`migrations/0002_outbox_claim_lease_index.sql`）が実際に使われることを assert する。
 *
 * 両方とも `console.log` で全文を出力する——「索引が使われるようになった」を出力そのもので
 * 示す必要がある（「使われるはず」と書かない）。CI のログから PR 本文へ貼るための意図的な
 * 出力であり、削らないこと。
 */

const TENANT = "outbox-claim-lease-tenant";
// btree の partial index をシーケンシャルスキャンより優先させるため、行数を多めに用意する
// （recall-gate-index.test.ts と同じ勘所）。
const ROW_COUNT = 5000;

/**
 * `outbox` に、次の組み合わせが満遍なく混ざったデータを大量に用意する:
 * - 完了済み（`completed_at` あり） / 失敗済み（`failed_at` あり） / 未終端
 * - 未終端のうち: 一度も claim されていない / リース内で claim 済み / リースが
 *   切れた状態で claim 済み
 * - `kind` は 'extract' / 'embed' の両方
 */
async function seedManyOutboxRows(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO outbox (
      id, tenant_id, kind, payload, available_at, claimed_at, claimed_by, attempts,
      completed_at, failed_at, created_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      CASE WHEN i % 2 = 0 THEN 'extract' ELSE 'embed' END,
      '{}'::jsonb,
      now() - (i || ' seconds')::interval,
      CASE
        WHEN i % 4 = 0 THEN now() - interval '2 hours'  -- リース切れ（claim 済み・未完了）
        WHEN i % 4 = 1 THEN now()                          -- リース内（claim 済み・未完了）
        ELSE NULL                                          -- 一度も claim されていない
      END,
      CASE WHEN i % 4 IN (0, 1) THEN 'worker-x' ELSE NULL END,
      0,
      CASE WHEN i % 10 = 0 THEN now() ELSE NULL END,       -- 完了済み
      CASE WHEN i % 10 = 1 THEN now() ELSE NULL END,       -- 失敗済み
      now()
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts の実測と同じ勘所: ANALYZE 無しでは別の索引が選ばれることがあった）。
  await pool.query("ANALYZE outbox");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("outbox claim のリース化と索引（ADR 0032）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: 今日の（claimed_at に触れない）述語では idx_outbox_pending が使われない（帰結2の実測）", async () => {
    const { pool } = await getTestClient();
    await seedManyOutboxRows(pool, TENANT, ROW_COUNT);

    const now = new Date();
    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       WITH claimable AS (
         SELECT id FROM outbox
         WHERE tenant_id = $1
           AND completed_at IS NULL
           AND failed_at IS NULL
           AND available_at <= $2
           AND kind = ANY($3::text[])
         ORDER BY available_at ASC
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
       SET claimed_at = $2, claimed_by = $5, attempts = attempts + 1
       FROM claimable c
       WHERE o.id = c.id
       RETURNING o.*`,
      [TENANT, now, ["extract", "embed"], 50, "worker-explain-before"],
    );
    const plan = planText(explainResult.rows as { "QUERY PLAN": string }[]);
    console.log(`=== EXPLAIN（前: claimed_at に触れない今日の述語）===\n${plan}`);

    // 帰結2の実測: idx_outbox_pending の述語（claimed_at IS NULL）はこの WHERE から
    // 含意されないため、プランナはこの索引を選べない。
    expect(plan).not.toContain("idx_outbox_pending");
  }, 60_000);

  it("後: リース条件付きの新しい述語では idx_outbox_claimable が実際に使われる", async () => {
    const { pool } = await getTestClient();
    await seedManyOutboxRows(pool, TENANT, ROW_COUNT);

    const now = new Date();
    const leaseMs = 60 * 60 * 1000; // 1時間（この検査自体の値。実運用のリース長とは無関係）。
    const leaseExpiresBefore = new Date(now.getTime() - leaseMs);

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       WITH claimable AS (
         SELECT id FROM outbox
         WHERE tenant_id = $1
           AND completed_at IS NULL
           AND failed_at IS NULL
           AND available_at <= $2
           AND (claimed_at IS NULL OR claimed_at <= $3)
           AND kind = ANY($4::text[])
         ORDER BY available_at ASC
         LIMIT $5
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
       SET claimed_at = $2, claimed_by = $6, attempts = attempts + 1
       FROM claimable c
       WHERE o.id = c.id
       RETURNING o.*`,
      [TENANT, now, leaseExpiresBefore, ["extract", "embed"], 50, "worker-explain-after"],
    );
    const plan = planText(explainResult.rows as { "QUERY PLAN": string }[]);
    console.log(`=== EXPLAIN（後: リース条件付きの新しい述語）===\n${plan}`);

    expect(plan).toContain("idx_outbox_claimable");
    expect(plan).not.toMatch(/Seq Scan on outbox/);
  }, 60_000);
});
