import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildPurgeExpiredRecallsTargetSelect } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0404 の実測（`purgeExpiredRecalls` が対象を選ぶ SELECT の計画）を、歯にする。
 *
 * `PostgresMemoryStore.purgeExpiredRecalls` が対象を選ぶ SELECT の中身は
 * `buildPurgeExpiredRecallsTargetSelect` が組み立てる。**この検査はその関数の返り値を
 * そのまま `EXPLAIN` する**——テスト側に述語を書き写さない
 * （`memory-events-retention-index.test.ts` の `explainTargetSelect` と同じ理由）。
 * 述語（`tenant_id`・`created_at < olderThan`・`ORDER BY created_at, id`）が変われば計画が変わり、
 * この歯が動く。
 *
 * ⚠ 兄弟（`memory-events-retention-index.test.ts` など）と向きが違う。ADR 0404 は
 * `recalls (tenant_id, created_at, id)` の索引を**足さない**と決めた（全 recall の INSERT に
 * 恒久的な上乗せが乗るため。migration 0032 は使わない）。だからここが縛るのは
 * 「専用の索引がある世界」ではなく、次の2つである。
 *
 * 1. **現状（ADR 0404 の決定どおり）**: 専用の索引が無く、`idx_recalls_by_subject
 *    (tenant_id, subject_id, created_at)` では `ORDER BY created_at, id` を供給できないので
 *    `Sort` が挟まる。**もし誰かが `recalls (tenant_id, created_at, ...)` の索引を足したら
 *    この it が赤くなる**——足す判断を ADR 0404 の「これが覆るとしたら」に当てて、この it を
 *    書き換えること（黙って計画が変わるのを許さない）。
 * 2. **陽性対照**: ADR 0404 の候補の索引を一時的に足すと、その索引が使われて `Sort` が消える。
 *    これが無いと、1 の「Sort がある」は「測る関数が別の SELECT を返している」ときも緑になる。
 *
 * 索引は `finally` で落とす（`resetTestDatabase()` は TRUNCATE するだけで DDL は戻さない）。
 * 全文を `console.log` で出力する。
 */

const TENANT = "recalls-purge-index-tenant";
const OTHER_TENANTS = ["recalls-purge-other-a", "recalls-purge-other-b", "recalls-purge-other-c"];
const ROWS_PER_TENANT = 30_000;

/** ADR 0404 が「足さない」と決めた候補の索引（migration には無い）。 */
const CANDIDATE_INDEX = "idx_recalls_purge_candidate_test_only";

async function seedRecalls(pool: Pool): Promise<void> {
  // subject_id は数十種類にばらす（実運用の recall は subject ごとに散る。`idx_recalls_by_subject` の
  // 先頭 2 列が `ORDER BY created_at` を供給できないことを、NULL 一色で隠さない）。
  for (const tenant of [TENANT, ...OTHER_TENANTS]) {
    await pool.query(
      `
      INSERT INTO recalls (id, tenant_id, subject_id, query, usage, index_band, returned_memories, created_at)
      SELECT
        gen_random_uuid(),
        $1,
        'subject-' || (i % 40),
        '{}'::jsonb,
        '{}'::jsonb,
        '{}'::jsonb,
        '[]'::jsonb,
        now() - (i || ' seconds')::interval
      FROM generate_series(1, $2) AS i
      `,
      [tenant, ROWS_PER_TENANT],
    );
  }
  await pool.query("ANALYZE recalls");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

const CTX: Ctx = { tenantId: TENANT };
// 対象は古い側の 2/3 ほど（ADR 0404 の「3万行が対象」に近い選択性）。limit は ADR と同じ 1000。
const OLDER_THAN = new Date(Date.now() - (ROWS_PER_TENANT / 3) * 1000);
const OPTS = { olderThan: OLDER_THAN, limit: 1000 };

/** 🔴 本体が実際に打つ `SELECT` をそのまま `EXPLAIN` する。 */
async function explainTargetSelect(lock: boolean): Promise<string> {
  const { db } = await getTestClient();
  const target = buildPurgeExpiredRecallsTargetSelect(CTX, OPTS, lock);
  const result = await db.execute(sql`EXPLAIN (FORMAT TEXT) ${target}`);
  return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
}

describe("recalls の保持期間掃除の対象選択（ADR 0404）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("現状: 専用の索引が無く、ORDER BY created_at, id に Sort が挟まる（索引を足さない決定）", async () => {
    const { pool } = await getTestClient();
    await seedRecalls(pool);

    const plan = await explainTargetSelect(false);
    console.log(`=== EXPLAIN（現状: recalls に専用の索引無し）===\n${plan}`);

    expect(plan).toContain("Sort");
    expect(plan).toContain("Sort Key: created_at, id");
    // 既存の索引は (tenant_id, subject_id, created_at)。created_at の全体順序は供給できない。
    expect(plan).not.toContain(CANDIDATE_INDEX);

    // 削除するとき（lock = true）は同じ選択に FOR UPDATE が付く。
    const locked = await explainTargetSelect(true);
    console.log(`=== EXPLAIN（現状・lock=true）===\n${locked}`);
    expect(locked).toContain("LockRows");
    expect(locked).toContain("Sort Key: created_at, id");
  }, 120_000);

  it("陽性対照: (tenant_id, created_at, id) の索引を足すと、その索引が使われ Sort が消える", async () => {
    const { pool } = await getTestClient();
    await seedRecalls(pool);

    await pool.query(`CREATE INDEX ${CANDIDATE_INDEX} ON recalls (tenant_id, created_at, id)`);
    try {
      await pool.query("ANALYZE recalls");
      const plan = await explainTargetSelect(false);
      console.log(`=== EXPLAIN（候補の索引を足した世界）===\n${plan}`);

      expect(plan).toContain(CANDIDATE_INDEX);
      expect(plan).not.toContain("Sort Key");
    } finally {
      await pool.query(`DROP INDEX IF EXISTS ${CANDIDATE_INDEX}`);
    }
  }, 120_000);
});
