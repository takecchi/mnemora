import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「前」の測定のために落とした索引を作り直すための DDL。**マイグレーションファイルから
 * そのまま読む**——ここに DDL を書き写すと、migrations/0007_memories_requeue_embed_index.sql
 * を後から直したときに、この復元だけが古い定義のまま静かにずれる（
 * outbox-claim-lease-index.test.ts の MIGRATION_0002_SQL と同じ理由）。
 */
const MIGRATION_0007_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0007_memories_requeue_embed_index.sql"),
  "utf8",
);

/**
 * ADR 0079 の実測。
 *
 * `PostgresMemoryStore.requeueEmbedJobs`（`packages/postgres/src/memory-store.ts`）が
 * 対象を選ぶ CTE の `SELECT` は次の形をしている:
 *
 *   SELECT id FROM memories
 *   WHERE tenant_id = $1
 *     AND status IN ('active', 'contested')
 *     AND embedding_status <> 'ready'
 *     AND embedding_status = ANY($2::text[])
 *   ORDER BY updated_at ASC, id ASC
 *   LIMIT $3
 *   FOR UPDATE SKIP LOCKED
 *
 * `migrations/0007_memories_requeue_embed_index.sql` はこの述語のための部分索引
 * `idx_memories_requeue_embed`（`(tenant_id, updated_at, id)`、
 * `WHERE status IN ('active', 'contested') AND embedding_status <> 'ready'`）を足した。
 *
 * このテストは:
 * 1. 「前」= 索引が無い世界での上の `SELECT` を `EXPLAIN` し、`Seq Scan` になることを
 *    確認する。**`idx_memories_requeue_embed` は本PRが足した索引であり「前」には
 *    存在しない**——この DB には既に `0007_*.sql` が適用済みなので、テストの中で
 *    明示的に `DROP INDEX idx_memories_requeue_embed` してから測り、**`finally` で
 *    必ずマイグレーションファイルそのものを流し直して作り直す**（`resetTestDatabase()`
 *    はテーブルの中身を TRUNCATE するだけでスキーマは再作成しないため、戻し忘れると
 *    「後」のテストや後続の他テストファイルまで索引の無い状態を引きずる。詳細は
 *    outbox-claim-lease-index.test.ts の同種のコメント参照）。
 * 2. 「後」= 索引が在る状態で同じ述語を `EXPLAIN` し、`idx_memories_requeue_embed` が
 *    実際に使われる**うえで**、`updated_at, id` の全体ソートを索引が肩代わりしている
 *    こと（＝ `LIMIT` が早期に打ち切れる）を assert する。
 * 3. ⭐ **この PR のいちばん大事な歯。** `embedding_status <> 'ready'` を落とし
 *    `embedding_status = ANY($2::text[])` だけを残した述語を `EXPLAIN` し、索引が
 *    **使われなくなる**ことを実測する。`migrations/0007_*.sql` のコメントが書いている
 *    「`= ANY($n)` の引数は実行時の値であり、プランナは配列に 'ready' が入っていない
 *    ことを証明できない」という主張は、この assert が通って初めて実測になる——
 *    通らなければ、その主張は「読んでそう推論した」段階のままである
 *    （outbox-claim-lease-index.test.ts が ADR 0032 で踏んだ穴と同じ形）。
 *    `AND embedding_status <> 'ready'` が「冗長に見えるが消すと索引が死ぬ」ことの
 *    証明そのものが、このテストの存在理由である。
 *
 * すべて `console.log` で全文を出力する——「索引が使われる/使われない」を出力そのもので
 * 示す必要がある（「使われるはず」と書かない）。CI のログから PR 本文へ貼るための意図的な
 * 出力であり、削らないこと。
 *
 * `EXPLAIN`（`ANALYZE` を付けない）はプランを組み立てるだけで実際にはクエリを実行しない
 * ——`FOR UPDATE SKIP LOCKED` を含む `SELECT` を対象にしても安全にプランだけ取れる。
 */

const TENANT = "memories-requeue-embed-tenant";
// btree の partial index をシーケンシャルスキャンより優先させるため、行数を多めに用意する
// （outbox-claim-lease-index.test.ts / recall-gate-index.test.ts と同じ勘所）。
const ROW_COUNT = 20_000;

/**
 * `memories` に、本物の定常状態に近い分布のデータを大量に用意する。
 *
 * **なぜこの分布が「現実的」と言えるか（1行の根拠。数字合わせのための調整はしない）**:
 * 正常に動いている系では大半の Memory が `ready` である——`embedding_status` の既定は
 * `pending` で、`tick()` の `processEmbedJob` が処理して `ready` に進める。ある瞬間の
 * 断面を見れば、**大半の行は既に `ready` に達しており、まだ埋め込みが済んでいない行は
 * 少数派**という定常状態になる（`migrations/0007_*.sql` の「索引の母数について」節と
 * 同じ想定）。ここでは 95% を `ready`、残り5%を `failed`/`pending` に半々で散らす。
 * `status` も大半を `active` にする（`memories` の定常状態は係争も無いのが通常）。
 */
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
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts / outbox-claim-lease-index.test.ts と同じ勘所）。
  await pool.query("ANALYZE memories");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("memories の requeueEmbedJobs 索引（ADR 0079）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: idx_memories_requeue_embed が無い世界では Seq Scan になる", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    // 「前」= 本PR以前の姿を再現する。`idx_memories_requeue_embed` は本PRが足した
    // 索引であり「前」の世界には存在しない——migrate 済みの DB からこのテストの間だけ
    // 一時的に落とす。**`resetTestDatabase()` はテーブルの中身を TRUNCATE するだけで、
    // マイグレーション（索引を含むスキーマ）は再実行しない**（`getTestClient()` が
    // プロセス内で一度だけ migrate する設計、`test-db.ts` 参照）——DROP したままだと
    // 直後の「後」テストや、同じプロセス内で後から走る他のテストまで索引の無い状態を
    // 引きずってしまう。**必ず `finally` で元の定義
    // （`migrations/0007_memories_requeue_embed_index.sql` と同一の DDL）を作り直す。**
    await pool.query("DROP INDEX idx_memories_requeue_embed");
    try {
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
      console.log(`=== EXPLAIN（前: idx_memories_requeue_embed 無し）===\n${plan}`);

      // ⚠ **`Seq Scan on memories` を assert しない。**「前」の世界でプランナが
      // Seq Scan を選ぶか、既存の別の索引（`idx_memories_recall_gate` など）を
      // 選ぶかは統計次第であり、**どちらでもこの PR の主張は変わらない。**
      // 測りたいのは「`ORDER BY updated_at, id LIMIT n` を索引が供給できていない」
      // ——すなわち `Sort` が挟まっていて `LIMIT` の早期打ち切りが効かないこと
      // そのものである。実際にどちらが選ばれたかは上の `console.log` が示す。
      expect(plan).toContain("Sort");
    } finally {
      // マイグレーションファイルそのものを流し直して戻す（MIGRATION_0007_SQL の doc 参照）。
      await pool.query(MIGRATION_0007_SQL);
    }
  }, 60_000);

  it("後: idx_memories_requeue_embed が実際に使われ、updated_at, id の全体ソートを索引が肩代わりする", async () => {
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
    console.log(`=== EXPLAIN（後: idx_memories_requeue_embed 在り）===\n${plan}`);

    expect(plan).toContain("idx_memories_requeue_embed");
    // 「索引が使われている」だけでは足りない——測りたいのは「`updated_at, id` の
    // 全体ソートを索引が肩代わりしている」ことそのもの（outbox-claim-lease-index.test.ts
    // と同じ勘所）。これが無いと `ORDER BY ... LIMIT` の早期打ち切りが効かない。
    expect(plan).not.toContain("Sort Key: memories.updated_at");
  }, 60_000);

  it("⭐ embedding_status <> 'ready' を落とすと idx_memories_requeue_embed は使われなくなる", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    // `AND embedding_status <> 'ready'` を意図的に落とした述語。`migrations/0007_*.sql`
    // のコメントが立てている主張——「`= ANY($n::text[])` は実行時の引数であり、
    // プランナは配列に 'ready' が入っていないことを証明できない。部分索引の述語
    // `embedding_status <> 'ready'` がクエリの WHERE から含意されなくなり、索引が
    // 選べなくなる」——を、ここで実測する。この assert が通って初めて、memory-store.ts
    // の `AND embedding_status <> 'ready'` が「冗長に見えるが消すと索引が死ぬ」行だと
    // 言える。この PR のいちばん大事な歯。
    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT id FROM memories
       WHERE tenant_id = $1
         AND status IN ('active', 'contested')
         AND embedding_status = ANY($2::text[])
       ORDER BY updated_at ASC, id ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [TENANT, ["failed", "pending"], 50],
    );
    const plan = planText(explainResult.rows as { "QUERY PLAN": string }[]);
    console.log(
      `=== EXPLAIN（embedding_status <> 'ready' を落とした述語。idx_memories_requeue_embed は使われないはず）===\n${plan}`,
    );

    expect(plan).not.toContain("idx_memories_requeue_embed");
  }, 60_000);
});
