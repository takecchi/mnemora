import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import {
  embeddingSpaceIndexName,
  embeddingSpaceTableName,
  embeddingSpaceZeroNormIndexName,
} from "../embedding-space-table.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * ⚠ migration ファイルの実際のテキストを `readFileSync` で読んで実行する（複製した SQL ではない）。
 *
 * ⚠ `runMigrations` のマイグレーション台帳（`_mnemora_migrations`）を経由しない。台帳は「1回だけ適用」を強制するため、
 * 同じ DB に対して 0022 を複数回・異なる状態で再実行する検査ができない。migration ファイルの SQL 文そのものを
 * （`BEGIN`/`SET LOCAL search_path`/本体/`COMMIT` という `migrate.ts` と同じ形で）直接発行する。
 */

const MIGRATION_PATH = fileURLToPath(
  new URL("../../migrations/0022_embedding_zero_norm_index.sql", import.meta.url),
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

/** `migrate.ts` の実装と同じ形（1トランザクション、`schema` があれば `SET LOCAL search_path`）。 */
async function runZeroNormMigrationSql(pool: Pool, schema?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (schema !== undefined) {
      // 対象スキーマに加えて、`vector_norm` 等の拡張が実際に在るスキーマ（既定 `public`）も乗せないと、裸の関数呼び出しが解決できない。
      await client.query(`SET LOCAL search_path TO "${schema}","public"`);
    }
    await client.query(MIGRATION_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const SHORT_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "zero-norm-migration-short",
  dimensions: 3,
};

// 歯2は別の空間を使う（歯1a が `SHORT_SPACE` の名前で最小限の生テーブルを作るので、同じテーブル名を2つの歯が別の形で扱う結合を避けるため）。
const REGISTER_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "zero-norm-migration-register",
  dimensions: 3,
};

// 63バイトを超えてハッシュ片を付与する経路を確実に踏む組。
const LONG_SPACE: EmbeddingSpaceId = {
  provider: "azure-openai",
  model: "text-embedding-3-large",
  dimensions: 3072,
};

const SCHEMA_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "zero-norm-migration-schema",
  dimensions: 3,
};
const TEST_SCHEMA = "mnemora_zero_norm_mig_test";

const VIEW_BASE_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "zero-norm-migration-view-base",
  dimensions: 3,
};
const VIEW_NAME = "memory_embeddings_zero_norm_mig_all_spaces";

describe("packages/postgres/migrations/0022_embedding_zero_norm_index.sql（Issue #956 / ADR 0343）", () => {
  afterAll(async () => {
    const { pool } = await getTestClient();
    await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(SHORT_SPACE)}`);
    await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(LONG_SPACE)}`);
    await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(REGISTER_SPACE)} CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await pool.query(`DROP VIEW IF EXISTS ${VIEW_NAME}`);
    await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(VIEW_BASE_SPACE)}`);
    await closeTestClient();
  });

  it("歯1a: 短い名前——migration が計算する索引名は embeddingSpaceZeroNormIndexName と一致する（切り詰め無し）", async () => {
    const { pool } = await getTestClient();
    const table = embeddingSpaceTableName(SHORT_SPACE);
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    // `registerEmbeddingSpace` は使わない——この歯が見たいのは migration の DO ブロック
    // の名前計算だけであり、`registerEmbeddingSpace` 自身の `CREATE INDEX IF NOT EXISTS`
    // が先に作ってしまうと migration が何もせず素通りし、何も検査できなくなる。
    await pool.query(
      `CREATE TABLE ${table} (tenant_id text, memory_id uuid, embedding vector(${SHORT_SPACE.dimensions}), model text, created_at timestamptz)`,
    );

    await runZeroNormMigrationSql(pool);

    const expected = embeddingSpaceZeroNormIndexName(SHORT_SPACE);
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname LIKE 'idx_memory_embeddings_zero_norm_%'",
      [table],
    );
    expect(rows.map((r) => r.indexname)).toEqual([expected]);
    expect(Buffer.byteLength(expected, "utf8")).toBeLessThanOrEqual(63);
  });

  it("歯1b: 63バイトを超える名前——migration が計算する索引名は embeddingSpaceZeroNormIndexName と一致する（切り詰め・ハッシュ片あり）", async () => {
    const { pool } = await getTestClient();
    const table = embeddingSpaceTableName(LONG_SPACE);
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(
      `CREATE TABLE ${table} (tenant_id text, memory_id uuid, embedding vector(3), model text, created_at timestamptz)`,
    );

    await runZeroNormMigrationSql(pool);

    const expected = embeddingSpaceZeroNormIndexName(LONG_SPACE);
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname LIKE 'idx_memory_embeddings_zero_norm_%'",
      [table],
    );
    expect(rows.map((r) => r.indexname)).toEqual([expected]);
    expect(Buffer.byteLength(expected, "utf8")).toBe(63);
    expect(expected).not.toBe(embeddingSpaceIndexName(LONG_SPACE));
  });

  it("歯2: registerEmbeddingSpace が作った（部分索引が無い）既存の空間に対し、migration を実行すると索引ができ、その後の registerEmbeddingSpace が2本目を作らない", async () => {
    const { pool } = await getTestClient();
    await registerEmbeddingSpace(pool, REGISTER_SPACE);
    const table = embeddingSpaceTableName(REGISTER_SPACE);
    const zeroIndexName = embeddingSpaceZeroNormIndexName(REGISTER_SPACE);
    await pool.query(`DROP INDEX IF EXISTS ${zeroIndexName}`);

    const beforeCount = await countZeroNormIndexes(pool, table);
    expect(beforeCount).toBe(0);

    await runZeroNormMigrationSql(pool);
    expect(await countZeroNormIndexes(pool, table)).toBe(1);

    await registerEmbeddingSpace(pool, REGISTER_SPACE);
    expect(await countZeroNormIndexes(pool, table)).toBe(1);
  });

  it("歯3: --schema（ADR 0057）を指定した場合、migration が作る索引はそのスキーマに入る", async () => {
    const { pool } = await getTestClient();
    await pool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: TEST_SCHEMA });
    await registerEmbeddingSpace(pool, SCHEMA_SPACE, { schema: TEST_SCHEMA });

    const table = embeddingSpaceTableName(SCHEMA_SPACE);
    const zeroIndexName = embeddingSpaceZeroNormIndexName(SCHEMA_SPACE);
    await pool.query(`DROP INDEX IF EXISTS "${TEST_SCHEMA}".${zeroIndexName}`);
    expect(await countZeroNormIndexesInSchema(pool, TEST_SCHEMA, table)).toBe(0);

    await runZeroNormMigrationSql(pool, TEST_SCHEMA);

    const { rows } = await pool.query<{ schemaname: string; indexname: string }>(
      "SELECT schemaname, indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
      [table, zeroIndexName],
    );
    expect(rows).toEqual([{ schemaname: TEST_SCHEMA, indexname: zeroIndexName }]);
    const { rows: publicRows } = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
      [zeroIndexName],
    );
    expect(publicRows.length).toBe(0);
  });

  it("歯4: 同じスキーマに `memory_embeddings_` で始まり `embedding vector` 列を持つビューが在っても、migration は失敗せず、実テーブルにだけ索引を作る", async () => {
    // `information_schema.columns` はビュー（と外部テーブル）の列も返す。0022 がそれを対象に含めると `CREATE INDEX` が失敗し、1ファイル=1トランザクションの migration 全体が止まる。
    const { pool } = await getTestClient();
    const table = embeddingSpaceTableName(VIEW_BASE_SPACE);
    await pool.query(`DROP VIEW IF EXISTS ${VIEW_NAME}`);
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(
      `CREATE TABLE ${table} (tenant_id text, memory_id uuid, embedding vector(${VIEW_BASE_SPACE.dimensions}), model text, created_at timestamptz)`,
    );
    await pool.query(
      `CREATE VIEW ${VIEW_NAME} AS SELECT tenant_id, memory_id, embedding FROM ${table}`,
    );

    await runZeroNormMigrationSql(pool);

    expect(await countZeroNormIndexes(pool, table)).toBe(1);
    expect(await countZeroNormIndexes(pool, VIEW_NAME)).toBe(0);
  });
});

async function countZeroNormIndexes(pool: Pool, table: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM pg_indexes WHERE tablename = $1 AND indexname LIKE 'idx_memory_embeddings_zero_norm_%'",
    [table],
  );
  return Number(rows[0]!.count);
}

async function countZeroNormIndexesInSchema(
  pool: Pool,
  schema: string,
  table: string,
): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname LIKE 'idx_memory_embeddings_zero_norm_%'",
    [schema, table],
  );
  return Number(rows[0]!.count);
}
