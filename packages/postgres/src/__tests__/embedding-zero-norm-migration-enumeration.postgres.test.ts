import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * 3条件のどれが欠けても、利用者が同じスキーマに置いた別のテーブルを巻き込む。名前が違うだけのテーブルへ勝手に索引が付き、
 * `embedding` 列が無い・`vector` 型でないテーブルでは `CREATE INDEX` が失敗して migration 全体が止まる（1ファイル=1トランザクション）。
 * 専用のスキーマの中で、本物の対象1つと、3条件のそれぞれを1つだけ欠いた「おとり」を並べて、migration ファイルの実際のテキストを読んで流す。
 */

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("../../migrations/0022_embedding_zero_norm_index.sql", import.meta.url)),
  "utf8",
);
const SCHEMA = "mnemora_zero_norm_enum_test";

async function runMigrationIn(pool: Pool, schema: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schema}","public"`);
    await client.query(MIGRATION_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function zeroNormIndexNames(pool: Pool, schema: string, table: string): Promise<string[]> {
  const { rows } = await pool.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname LIKE 'idx_memory_embeddings_zero_norm_%' ORDER BY indexname",
    [schema, table],
  );
  return rows.map((r) => r.indexname);
}

describe("0022 が部分索引を作る対象は、memory_embeddings_ で始まり embedding 列が vector 型の実テーブルだけ（ADR 0343）", () => {
  beforeAll(async () => {
    const { pool } = await getTestClient();
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pool.query(
      `CREATE TABLE "${SCHEMA}".memory_embeddings_enum_target (tenant_id text, memory_id uuid, embedding public.vector(3))`,
    );
    await pool.query(
      `CREATE TABLE "${SCHEMA}".my_notes (tenant_id text, memory_id uuid, embedding public.vector(3))`,
    );
    await pool.query(
      `CREATE TABLE "${SCHEMA}".memory_embeddings_enum_nocolumn (tenant_id text, memory_id uuid, vec public.vector(3))`,
    );
    await pool.query(
      `CREATE TABLE "${SCHEMA}".memory_embeddings_enum_nottype (tenant_id text, memory_id uuid, embedding float4[])`,
    );
  });

  afterAll(async () => {
    const { pool } = await getTestClient();
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await closeTestClient();
  });

  it("おとりがあっても migration は失敗せず、本物の対象にだけ索引を作る", async () => {
    const { pool } = await getTestClient();

    await runMigrationIn(pool, SCHEMA);

    expect(await zeroNormIndexNames(pool, SCHEMA, "memory_embeddings_enum_target")).toEqual([
      "idx_memory_embeddings_zero_norm_enum_target",
    ]);
    expect(await zeroNormIndexNames(pool, SCHEMA, "my_notes")).toEqual([]);
    expect(await zeroNormIndexNames(pool, SCHEMA, "memory_embeddings_enum_nocolumn")).toEqual([]);
    expect(await zeroNormIndexNames(pool, SCHEMA, "memory_embeddings_enum_nottype")).toEqual([]);
  });

  it("作られる索引は (tenant_id, memory_id) の列で、vector_norm(embedding) = 0 の行だけを持つ部分索引（> 0 や全行ではない）", async () => {
    const { pool } = await getTestClient();
    await runMigrationIn(pool, SCHEMA);

    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3",
      [SCHEMA, "memory_embeddings_enum_target", "idx_memory_embeddings_zero_norm_enum_target"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(
      /\(tenant_id, memory_id\) WHERE \(vector_norm\(embedding\) = /,
    );

    // 述語が「= 0」であることは、プランナがこの索引を `vector_norm(embedding) = 0` の問い合わせに
    // 選べるかでも見る（述語を含意しない索引は、seqscan を切っても選ばれない）。
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const plan = await client.query<Record<string, string>>(
        `EXPLAIN SELECT memory_id FROM "${SCHEMA}".memory_embeddings_enum_target WHERE tenant_id = 'a' AND public.vector_norm(embedding) = 0`,
      );
      const text = plan.rows.map((r) => Object.values(r)[0]).join("\n");
      expect(text).toContain("idx_memory_embeddings_zero_norm_enum_target");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
