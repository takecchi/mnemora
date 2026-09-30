import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { buildPurgeCompletedJobsTargetSelect } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** `recalls-purge-index.test.ts` と同じ理由で、復元用の DDL は migration からそのまま読む。 */
// 読むのは復元のときだけ（migration が無い世界では、読む前に「索引が無い」で赤くなる）。
const migration0032Sql = (): string =>
  readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0032_purge_indexes.sql"), "utf8");
const PURGE_INDEXES = ["idx_recalls_by_created", "idx_outbox_completed"];

/**
 * ADR 0404 / ADR 0412 の実測（`purgeCompletedJobs` が対象を選ぶ SELECT の計画）を、歯にする。
 *
 * 本体が打つ SELECT は `buildPurgeCompletedJobsTargetSelect`（`../outbox-store.js`）が組み立てる。
 * **この検査はその関数の返り値をそのまま `EXPLAIN` する**——述語を書き写さない。
 *
 * outbox の既存の索引はどれも `completed_at IS NULL` の部分索引（未処理の行のための索引）で、
 * `completed_at IS NOT NULL` の問い合わせには使えない。ADR 0412 の索引
 * `idx_outbox_completed (tenant_id, completed_at, id) WHERE completed_at IS NOT NULL` が無いと、
 * 対象が 0 件でも表を全部読む。縛るのは次の3つ。
 *
 * 1. **後・対象あり**: Index Scan になり、`Sort` も `Seq Scan` も無い。
 * 2. **後・対象 0 件**: 同じく `Seq Scan` が無く、`EXPLAIN (ANALYZE, BUFFERS)` の読んだバッファが
 *    表のページ数よりはるかに小さい（表を全部は読まない）。
 * 3. **前（陽性対照）**: 索引を落とすと `Seq Scan` になり、対象 0 件でも読んだバッファが表のページ数
 *    に近づく。これが無いと、1・2 の「無い／小さい」は「測る関数が別の SELECT を返している」
 *    「そもそも表が小さい」ときも緑になる。
 *
 * 索引は `finally` で作り直す。全文を `console.log` で出力する。
 */

const TENANT = "outbox-purge-index-tenant";
const OTHER_TENANTS = ["outbox-purge-other-a", "outbox-purge-other-b", "outbox-purge-other-c"];
const ROWS_PER_TENANT = 30_000;

/**
 * 本物のワークキューに近い分布: 96% が完了済み、1% が failed、3% が未処理。
 * 完了時刻は `now() - i 秒`。他のテナントにも同じだけ入れ、`tenant_id` の絞りが効く形にする。
 */
async function seedOutbox(pool: Pool): Promise<void> {
  for (const tenant of [TENANT, ...OTHER_TENANTS]) {
    await pool.query(
      `
      INSERT INTO outbox (id, tenant_id, kind, payload, available_at, completed_at, failed_at)
      SELECT
        gen_random_uuid(),
        $1,
        'embed',
        '{}'::jsonb,
        now() - (i || ' seconds')::interval,
        CASE WHEN i % 100 < 96 THEN now() - (i || ' seconds')::interval END,
        CASE WHEN i % 100 = 96 THEN now() - (i || ' seconds')::interval END
      FROM generate_series(1, $2) AS i
      `,
      [tenant, ROWS_PER_TENANT],
    );
  }
  await pool.query("ANALYZE outbox");
}

const CTX: Ctx = { tenantId: TENANT };
// 対象あり: 古い側の 2/3 ほどが対象。limit は ADR 0404 の測定と同じ 100。
const WITH_TARGETS = { olderThan: new Date(Date.now() - (ROWS_PER_TENANT / 3) * 1000), limit: 100 };
// 対象 0 件: 全行より古い時刻を切り口にする。
const NO_TARGETS = { olderThan: new Date(Date.now() - 10 * 365 * 24 * 3600 * 1000), limit: 100 };

type PlanNode = {
  "Node Type": string;
  "Actual Rows": number;
  "Shared Hit Blocks": number;
  "Shared Read Blocks": number;
  Plans?: PlanNode[];
};

async function explainText(opts: typeof WITH_TARGETS, lock: boolean): Promise<string> {
  const { db } = await getTestClient();
  const result = await db.execute(
    sql`EXPLAIN (FORMAT TEXT) ${buildPurgeCompletedJobsTargetSelect(CTX, opts, lock)}`,
  );
  return (result.rows as unknown as { "QUERY PLAN": string }[])
    .map((row) => row["QUERY PLAN"])
    .join("\n");
}

/** `EXPLAIN (ANALYZE, BUFFERS)`。`lock = false` で実行する（行ロックを取らない）。 */
async function analyze(
  opts: typeof WITH_TARGETS,
): Promise<{ text: string; plan: PlanNode; buffers: number; tablePages: number }> {
  const { db, pool } = await getTestClient();
  const target = buildPurgeCompletedJobsTargetSelect(CTX, opts, false);
  const text = planTextOf(
    (await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${target}`)).rows,
  );
  const json = (await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${target}`))
    .rows as unknown as { "QUERY PLAN": { Plan: PlanNode }[] }[];
  const plan = json[0]!["QUERY PLAN"][0]!.Plan;
  const pages = await pool.query("SELECT relpages FROM pg_class WHERE relname = 'outbox'");
  return {
    text,
    plan,
    buffers: plan["Shared Hit Blocks"] + plan["Shared Read Blocks"],
    tablePages: Number(pages.rows[0].relpages),
  };
}

function planTextOf(rows: unknown[]): string {
  return (rows as { "QUERY PLAN": string }[]).map((row) => row["QUERY PLAN"]).join("\n");
}

describe("outbox の完了済みジョブ掃除の対象選択（ADR 0404 / ADR 0412）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("後・対象あり: idx_outbox_completed が使われ、Sort も Seq Scan も無い（削除するときの FOR UPDATE SKIP LOCKED でも）", async () => {
    const { pool } = await getTestClient();
    await seedOutbox(pool);

    const plan = await explainText(WITH_TARGETS, false);
    console.log(`=== EXPLAIN（後・対象あり: idx_outbox_completed 在り）===\n${plan}`);
    expect(plan).toMatch(/Index (Only )?Scan using idx_outbox_completed on outbox/);
    expect(plan).not.toContain("Sort");
    expect(plan).not.toContain("Seq Scan");

    const locked = await explainText(WITH_TARGETS, true);
    console.log(`=== EXPLAIN（後・対象あり・lock=true）===\n${locked}`);
    expect(locked).toContain("LockRows");
    expect(locked).toMatch(/Index Scan using idx_outbox_completed on outbox/);
    expect(locked).not.toContain("Sort");
    expect(locked).not.toContain("Seq Scan");
  }, 120_000);

  it("後・対象 0 件: Seq Scan が無く、表を全部は読まない（読んだバッファが表のページ数の 2% 未満）", async () => {
    const { pool } = await getTestClient();
    await seedOutbox(pool);

    const { text, plan, buffers, tablePages } = await analyze(NO_TARGETS);
    console.log(
      `=== EXPLAIN ANALYZE（後・対象 0 件）buffers=${buffers} tablePages=${tablePages} ===\n${text}`,
    );
    expect(plan["Actual Rows"]).toBe(0);
    expect(text).toMatch(/Index (Only )?Scan using idx_outbox_completed on outbox/);
    expect(text).not.toContain("Seq Scan");
    // 陽性対照の側（下の it）が表の 90% 以上を読むことを示す。ここは「表のページ数」との比で縛る
    // （絶対数だと行数を変えたときに意味が変わる）。
    expect(tablePages).toBeGreaterThan(500);
    expect(buffers).toBeLessThan(tablePages * 0.02);
  }, 120_000);

  it("前（陽性対照）: 索引を落とすと Seq Scan になり、対象 0 件でも表をほぼ全部読む", async () => {
    const { pool } = await getTestClient();
    await seedOutbox(pool);

    // 0032 は recalls と outbox の2本を作る。DDL の復元は 0032 をそのまま流すので、2本とも落とす。
    for (const index of PURGE_INDEXES) await pool.query(`DROP INDEX ${index}`);
    try {
      await pool.query("ANALYZE outbox");
      const { text, buffers, tablePages } = await analyze(NO_TARGETS);
      console.log(
        `=== EXPLAIN ANALYZE（前・対象 0 件: idx_outbox_completed 無し）buffers=${buffers} tablePages=${tablePages} ===\n${text}`,
      );
      expect(text).toContain("Seq Scan on outbox");
      expect(text).not.toContain("idx_outbox_completed");
      expect(buffers).toBeGreaterThan(tablePages * 0.9);
    } finally {
      await pool.query(migration0032Sql());
      await pool.query("ANALYZE outbox");
    }
  }, 120_000);
});
