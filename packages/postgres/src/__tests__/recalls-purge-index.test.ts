import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { buildPurgeExpiredRecallsTargetSelect } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「前」の測定のために落とした索引を作り直すための DDL。**マイグレーションファイルから
 * そのまま読む**——ここに DDL を書き写すと、migrations/0032_purge_indexes.sql を後から直したときに、
 * この復元だけが古い定義のまま静かにずれる（`memory-events-retention-index.test.ts` と同じ理由）。
 * 0032 は `recalls` と `outbox` の2本を作る。**どちらも落として、どちらも作り直す**
 * （片方だけ落としてこの DDL を流すと、残った側が「既に存在する」で失敗する）。
 */
// 読むのは復元のときだけ（migration が無い世界では、読む前に「索引が無い」で赤くなる）。
const migration0032Sql = (): string =>
  readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0032_purge_indexes.sql"), "utf8");
const PURGE_INDEXES = ["idx_recalls_by_created", "idx_outbox_completed"];

/**
 * ADR 0404 の実測を歯にした検査。向きは ADR 0412 で改めた（0404 は索引を足さないと決め、
 * この検査は「Sort が入る」ことを縛っていた。0412 が `recalls (tenant_id, created_at, id)` を足した）。
 *
 * `PostgresMemoryStore.purgeExpiredRecalls` が対象を選ぶ SELECT の中身は
 * `buildPurgeExpiredRecallsTargetSelect` が組み立てる。**この検査はその関数の返り値を
 * そのまま `EXPLAIN` する**——テスト側に述語を書き写さない
 * （`memory-events-retention-index.test.ts` の `explainTargetSelect` と同じ理由）。
 * 述語（`tenant_id`・`created_at < olderThan`・`ORDER BY created_at, id`）が変われば計画が変わり、
 * この歯が動く。
 *
 * 1. **後** = migration 0032 の索引 `idx_recalls_by_created` が在る世界。Index Scan（削除しない
 *    ときは Index Only Scan もありうる）になり、`Sort` も `Seq Scan` も無い。`FOR UPDATE` 付き
 *    （削除するとき）でも同じ。
 * 2. **前（陽性対照）** = その索引を落とした世界。`Sort` が挟まる。これが無いと、1 の
 *    「Sort が無い」は「測る関数が別の SELECT を返している」ときも緑になる。
 *
 * 索引は `finally` で作り直す（`resetTestDatabase()` は TRUNCATE するだけで DDL は戻さない）。
 * 全文を `console.log` で出力する。
 */

const TENANT = "recalls-purge-index-tenant";
const OTHER_TENANTS = ["recalls-purge-other-a", "recalls-purge-other-b", "recalls-purge-other-c"];
const ROWS_PER_TENANT = 30_000;

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

describe("recalls の保持期間掃除の対象選択（ADR 0404 / ADR 0412）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("後: idx_recalls_by_created が使われ、Sort も Seq Scan も無い", async () => {
    const { pool } = await getTestClient();
    await seedRecalls(pool);

    const plan = await explainTargetSelect(false);
    console.log(`=== EXPLAIN（後: idx_recalls_by_created 在り）===\n${plan}`);

    expect(plan).toMatch(/Index (Only )?Scan using idx_recalls_by_created on recalls/);
    expect(plan).not.toContain("Sort");
    expect(plan).not.toContain("Seq Scan");

    // 削除するとき（lock = true）は同じ選択に FOR UPDATE が付く。
    const locked = await explainTargetSelect(true);
    console.log(`=== EXPLAIN（後・lock=true）===\n${locked}`);
    expect(locked).toContain("LockRows");
    expect(locked).toMatch(/Index Scan using idx_recalls_by_created on recalls/);
    expect(locked).not.toContain("Sort");
    expect(locked).not.toContain("Seq Scan");
  }, 120_000);

  it("前（陽性対照）: 索引を落とすと ORDER BY created_at, id に Sort が挟まる", async () => {
    const { pool } = await getTestClient();
    await seedRecalls(pool);

    // 0032 は recalls と outbox の2本を作る。DDL の復元は 0032 をそのまま流すので、2本とも落とす。
    for (const index of PURGE_INDEXES) await pool.query(`DROP INDEX ${index}`);
    try {
      await pool.query("ANALYZE recalls");
      const plan = await explainTargetSelect(false);
      console.log(`=== EXPLAIN（前: idx_recalls_by_created 無し）===\n${plan}`);

      // 既存の索引は (tenant_id, subject_id, created_at)。created_at の全体順序は供給できない。
      expect(plan).toContain("Sort");
      expect(plan).toContain("Sort Key: created_at, id");
      expect(plan).not.toContain("idx_recalls_by_created");
    } finally {
      await pool.query(migration0032Sql());
      await pool.query("ANALYZE recalls");
    }
  }, 120_000);
});
