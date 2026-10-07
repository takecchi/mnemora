import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 「前」の測定のために落とした索引を作り直すための DDL。マイグレーションファイルからそのまま読む（書き写すと、migration を直したときにこの復元だけが古い定義のまま静かにずれる）。 */
const MIGRATION_0002_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0002_outbox_claim_lease_index.sql"),
  "utf8",
);

/**
 * `claimBatch` の `WHERE` が `claimed_at` に触れないと、部分索引 `idx_outbox_pending`（`WHERE completed_at IS NULL AND claimed_at IS NULL`）の述語がクエリの WHERE から含意されず、プランナはその索引を使えない。
 * 新設した `idx_outbox_claimable` は列順 `(tenant_id, available_at)` にしてある。`claimBatch` は `kind = ANY(ARRAY['extract','embed'])` のように複数の kind を指定するので、
 * `(tenant_id, kind, available_at)` だと `kind` を単一の値に絞らない限り索引は `available_at` の全体順序を提供できず、`Sort` が挟まって `ORDER BY ... LIMIT n` の早期打ち切りが効かない。`kind` は残った行への `Filter` に任せる。
 *
 * 1. 「前」= `idx_outbox_claimable` が存在しない世界で、`claimed_at` に触れない述語を実際の `claimBatch` と同じ SQL 構造で `EXPLAIN` し、`idx_outbox_pending` が使われていないことを確認する。
 *    テストの中で `DROP INDEX idx_outbox_claimable` してから測り、`finally` で必ず作り直す（`resetTestDatabase()` はスキーマを再作成しないので、戻し忘れると後続のテストファイルまで索引の無い状態を引きずる）。
 *    `EXPLAIN`（`ANALYZE` を付けない）はプランを組み立てるだけでクエリを実行しないので、`UPDATE` 文を対象にしても安全。
 * 2. 「後」= リース条件付きの述語を同じ構造で `EXPLAIN` し、`idx_outbox_claimable` が使われるうえで、`available_at` の全体ソートを索引が肩代わりしていること（`LIMIT` が早期に打ち切れる）を assert する。
 *
 * 両方とも `console.log` で全文を出力する。「索引が使われるようになった」を出力そのもので示すための意図的な出力で、削らないこと。
 */

const TENANT = "outbox-claim-lease-tenant";
// btree の partial index をシーケンシャルスキャンより優先させるため、行数を多めに用意する。claim 可能な行の絶対数が少なすぎても索引が選ばれにくい。
const ROW_COUNT = 20_000;

/** 本物のワークキューに近い分布にする。大半の行は既に `completed_at`/`failed_at` が付いており、「まだ claim できる」行は少数派（95% を終端済み、5% を未終端）。部分索引が Seq Scan に勝てる前提になる。 */
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
      -- claimed_at: 未終端行(i % 20 = 0)の内訳をさらに3分割する。
      -- 終端済み行(completed/failed)は claim 履歴の有無がクエリの選択性に影響しない
      -- ため NULL のままにする(claimBatch は completed_at/failed_at で先に弾く)。
      CASE
        WHEN i % 20 != 0 THEN NULL
        WHEN i % 60 = 0 THEN NULL                       -- 未終端・一度も claim されていない
        WHEN i % 60 = 20 THEN now()                      -- 未終端・リース内で claim 済み
        ELSE now() - interval '2 hours'                  -- 未終端・リースが切れて claim 済み
      END,
      CASE WHEN i % 20 = 0 AND i % 60 != 0 THEN 'worker-x' ELSE NULL END,
      0,
      -- completed_at: 全体の90%(i % 20 が 2..19 の18値)を完了済みにする。
      CASE WHEN i % 20 IN (0, 1) THEN NULL ELSE now() END,
      -- failed_at: 全体の5%(i % 20 = 1)を失敗済みにする。
      CASE WHEN i % 20 = 1 THEN now() ELSE NULL END,
      now()
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ。
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

  it("前: idx_outbox_claimable が無い世界(本PR以前)では、claimed_at に触れない述語でも idx_outbox_pending は使われない(帰結2の実測)", async () => {
    const { pool } = await getTestClient();
    await seedManyOutboxRows(pool, TENANT, ROW_COUNT);
    // 「前」の世界を作るため、migrate 済みの DB からこのテストの間だけ索引を落とす。`resetTestDatabase()` はマイグレーションを再実行しないので、DROP したままだと後続のテストまで索引の無い状態を引きずる。必ず `finally` で元の定義を作り直す。
    await pool.query("DROP INDEX idx_outbox_claimable");
    try {
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
      console.log(
        `=== EXPLAIN（前: idx_outbox_claimable 無し・claimed_at に触れない今日の述語）===\n${plan}`,
      );

      // `idx_outbox_pending` の述語（claimed_at IS NULL）はこの WHERE から含意されないため、プランナはこの索引を選べない。
      expect(plan).not.toContain("idx_outbox_pending");
    } finally {
      await pool.query(MIGRATION_0002_SQL);
    }
  }, 60_000);

  it("後: リース条件付きの新しい述語では idx_outbox_claimable が実際に使われ、available_at の全体ソートを索引が肩代わりする", async () => {
    const { pool } = await getTestClient();
    await seedManyOutboxRows(pool, TENANT, ROW_COUNT);

    const now = new Date();
    const leaseMs = 60 * 60 * 1000; // 1時間(この検査自体の値。実運用のリース長とは無関係)。
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

    // ⚠ この2行はプランナの選択を assert しており、版・統計・データ規模に依存する。赤くなったら、自分の変更の前に Postgres のメジャー版・ANALYZE・seed の分布を疑い、まず `origin/main` で対照を取ること。
    expect(plan).toContain("idx_outbox_claimable");
    // 「索引が使われている」だけでは足りない。`Seq Scan on outbox` は外側の `UPDATE ... FROM claimable c` 側にも出うるので、それを禁止する assert は測りたいものを測れない。
    // 測りたいのは CTE 側で `available_at` の全体ソートを索引が肩代わりしていることそのもの（これが無いと `ORDER BY ... LIMIT` の早期打ち切りが効かない）。
    expect(plan).not.toContain("Sort Key: outbox.available_at");
  }, 60_000);
});
