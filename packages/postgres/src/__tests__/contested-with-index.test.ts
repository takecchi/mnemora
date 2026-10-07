import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「索引 idx_memories_contested_with が存在する」という assert は書かない（存在してもプランナに選ばれなければ DELETE は遅いまま）。
 * DELETE の所要時間に対する assert も書かない（CI ランナーの混雑・キャッシュ状態で揺れる）。
 * 代わりに、プランナが実際に選んだ実行計画のノード種別（Seq Scan か Index Scan か）を `EXPLAIN` のテキストから assert する。
 *
 * 行数を多くするのは、btree の部分索引が Seq Scan より有利になるために十分な規模が要るため。
 * `EXPLAIN (ANALYZE, BUFFERS)` の全文は `console.log` で出力する。CI ログから実測値を確認するための意図的な出力で、削らない。
 */

const TENANT = "contested-with-index-tenant";
const ROW_COUNT = 100_000;
const CONTESTED_PAIR_COUNT = 1_000; // 2,000行 = 全体の2%

/** DDL はここに書き写さず、マイグレーションファイルからそのまま読む（マイグレーションを直したときに「作り直し」だけが古い定義のまま静かにずれないため）。 */
const MIGRATION_0004_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0004_contested_with_index.sql"),
  "utf8",
);

interface SeededMemories {
  /** 争われている側の id（この id への DELETE が RI チェックの対象になる）。 */
  contestedTargetId: string;
  /** contestedTargetId を contested_with_id として指している側の id。 */
  contestedReferrerId: string;
}

/**
 * memories に、本物に近い分布のデータをバルク SQL で大量投入する（100,000件を現実的な時間で入れるため）。
 * 先頭 `CONTESTED_PAIR_COUNT * 2` 行を2行1組で互いの contested_with_id に指定する。同一 INSERT 文の中で自己参照するが、
 * 非遅延（NOT DEFERRABLE）の FK 制約は文の実行完了後にまとめて検査されるため、違反にならない。
 */
async function seedContestedMemories(
  pool: Pool,
  tenant: string,
  rowCount: number,
  contestedPairCount: number,
): Promise<SeededMemories> {
  const ids: string[] = Array.from({ length: rowCount }, () => randomUUID());
  const contestedWithIds: (string | null)[] = new Array(rowCount).fill(null);

  for (let pair = 0; pair < contestedPairCount; pair += 1) {
    const a = pair * 2;
    const b = a + 1;
    contestedWithIds[a] = ids[b]!;
    contestedWithIds[b] = ids[a]!;
  }

  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, contested_with_id,
      tags, recorded_at, strength, half_life_hours, decay_floor_at,
      embedding_status, created_at, updated_at
    )
    SELECT
      m.id,
      $2,
      'seed memory ' || m.id::text,
      md5(m.id::text),
      'seed digest ' || m.id::text,
      'llm',
      'imported',
      '{"kind":"imported"}'::jsonb,
      CASE WHEN m.contested_with_id IS NOT NULL THEN 'contested' ELSE 'active' END,
      m.contested_with_id,
      '{}'::text[],
      now(),
      1.0,
      720,
      now() + interval '30 days',
      'ready',
      now(),
      now()
    FROM unnest($1::uuid[], $3::uuid[]) AS m(id, contested_with_id)
    `,
    [ids, tenant, contestedWithIds],
  );

  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ。
  await pool.query("ANALYZE memories");

  return {
    contestedTargetId: ids[0]!,
    contestedReferrerId: ids[1]!,
  };
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** Postgres の参照整合性トリガーが自己参照 FK の DELETE 時に発行するのと同じ構造のクエリ。`ANALYZE` を付けて実際に実行する。 */
async function explainRiCheck(pool: Pool, targetId: string): Promise<string> {
  const result = await pool.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT 1 FROM ONLY "public"."memories" x
     WHERE $1 OPERATOR(pg_catalog.=) "contested_with_id" FOR KEY SHARE OF x`,
    [targetId],
  );
  return planText(result.rows);
}

describe("idx_memories_contested_with（memories.contested_with_id の自己参照 FK 索引）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: idx_memories_contested_with が無い世界(本PR以前)では、RI チェックが memories を Seq Scan する", async () => {
    const { pool } = await getTestClient();
    const seeded = await seedContestedMemories(pool, TENANT, ROW_COUNT, CONTESTED_PAIR_COUNT);

    // 「前」の状態を再現するため、migrate 済みの DB からこのテストの間だけ索引を落とす。
    // `resetTestDatabase()` は索引を再作成しないため、必ず `finally` で元の定義を作り直す（戻し忘れると、同じプロセス内で後から走る他のテストファイルまで索引の無い状態を引きずる）。
    await pool.query("DROP INDEX idx_memories_contested_with");
    try {
      const plan = await explainRiCheck(pool, seeded.contestedTargetId);
      console.log(
        `=== EXPLAIN（前: idx_memories_contested_with 無し・RI チェックの述語）===\n${plan}`,
      );

      expect(plan).toMatch(/Seq Scan on memories x/);
      expect(plan).not.toContain("idx_memories_contested_with");
    } finally {
      await pool.query(MIGRATION_0004_SQL);
    }
  }, 60_000);

  it("後: idx_memories_contested_with がある世界では、RI チェックは Index Scan になり Seq Scan は使われない", async () => {
    const { pool } = await getTestClient();
    const seeded = await seedContestedMemories(pool, TENANT, ROW_COUNT, CONTESTED_PAIR_COUNT);

    const plan = await explainRiCheck(pool, seeded.contestedTargetId);
    console.log(
      `=== EXPLAIN（後: idx_memories_contested_with 有り・RI チェックの述語）===\n${plan}`,
    );

    // ⚠ この3行はプランナの選択を assert しており、版・統計・データ規模に依存する（2% 選択性という閾値の上に立つので、コストモデルが版で変われば真っ先に転ぶ）。
    // 赤くなったら、自分の変更の前に Postgres のメジャー版・ANALYZE・seed の分布を疑い、まず `origin/main` で対照を取ること。
    expect(plan).toContain("idx_memories_contested_with");
    expect(plan).toMatch(/Index Scan using idx_memories_contested_with on memories x/);
    expect(plan).not.toMatch(/Seq Scan on memories/);

    // 索引の話とデータの話の両方を検査する（「索引はあるが述語を書き間違えて何も拾えていない」を見逃さないため）。
    const dataResult = await pool.query<{ id: string }>(
      `SELECT id FROM memories WHERE tenant_id = $1 AND contested_with_id = $2`,
      [TENANT, seeded.contestedTargetId],
    );
    expect(dataResult.rows.map((row) => row.id)).toEqual([seeded.contestedReferrerId]);
  }, 60_000);

  /**
   * 上の EXPLAIN assert は Index Scan という結果しか見ないので、先頭列を (tenant_id, contested_with_id) にした索引や
   * 部分述語を落とした無条件索引でも、プランナに選ばれてしまい検出できない。そこで pg_catalog から索引の形そのものを読む。
   * 先頭列は `pg_indexes.indexdef` の文字列一致ではなく、`pg_index.indkey[0]` が指す `pg_attribute.attnum` を解決する（表記に依存しないため）。
   */
  it("索引の形: idx_memories_contested_with は contested_with_id を先頭列に持つ部分索引である（マイグレーションのコメントの主張を歯にする）", async () => {
    const { pool } = await getTestClient();

    const shapeResult = await pool.query<{
      leading_col: string;
      is_partial: boolean;
      pred_expr: string | null;
    }>(
      `SELECT
         a.attname AS leading_col,
         i.indpred IS NOT NULL AS is_partial,
         pg_get_expr(i.indpred, i.indrelid) AS pred_expr
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indexrelid = 'idx_memories_contested_with'::regclass`,
    );

    expect(shapeResult.rows).toHaveLength(1);
    const shape = shapeResult.rows[0]!;
    expect(shape.leading_col).toBe("contested_with_id");
    expect(shape.is_partial).toBe(true);
    expect(shape.pred_expr).toBe("(contested_with_id IS NOT NULL)");
  });
});
