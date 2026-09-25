import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceIndexName, embeddingSpaceTableName } from "../embedding-space-table.js";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `registerEmbeddingSpace` の dimensions 上限検査（Issue #776 / ADR 0018 C-2）。
 *
 * ADR 0018 C-2 が実測して記録した不具合をここで固定する——`dimensions > 2000` の
 * `EmbeddingSpaceId` を渡すと、`CREATE TABLE IF NOT EXISTS` は成功するが続く
 * `CREATE INDEX ... USING hnsw` が pgvector の `54000`
 * （"column cannot have more than 2000 dimensions for hnsw index"）で失敗し、
 * **テーブルだけが残る**（ADR 0018 は「ここでは直さない」と明記して記録に留めていた）。
 *
 * ここで固定する3点:
 * - `dimensions=2000` は通る（テーブル・索引の両方が作られる。ADR 0018 の実測どおり、
 *   2000 は pgvector hnsw の有効な境界）。
 * - `dimensions=2001` は拒否され、テーブルが1つも残らない（`to_regclass` で不在を確認）。
 * - 拒否時のエラーはロック取得より前の入力検証と同じ流儀（`Error`、"invalid embedding
 *   space dimensions" を含むメッセージ）で投げられる。
 *
 * `runMigrations` を先に通してから使い捨ての DB へ対して実行する構造は
 * `vector-space-concurrency.test.ts` と同じ（`registerEmbeddingSpace` の FK 先である
 * `memories` テーブルを用意するため）。
 */

const DB_NAME = "mnemora_vs_dims_limit";

const SPACE_AT_LIMIT = { provider: "test", model: "vs-dims-limit-at-2000", dimensions: 2000 };
const SPACE_OVER_LIMIT = { provider: "test", model: "vs-dims-limit-over-2001", dimensions: 2001 };

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function createMigratedDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 5 });
  openedPools.push(pool);
  await runMigrations(pool);
  return pool;
}

/** `to_regclass(...) IS NOT NULL` で存在確認する（`dedicated-schema.postgres.test.ts` と同じ理由で `::text` の文字列一致にしない）。 */
async function regclassExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [name],
  );
  return rows[0]!.exists;
}

describe("registerEmbeddingSpace の dimensions 上限検査（pgvector hnsw、ADR 0018 C-2）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("dimensions=2000 は通り、テーブル・索引の両方が作られる（pgvector hnsw の有効な境界）", async () => {
    const pool = await createMigratedDatabase(DB_NAME);

    const result = await registerEmbeddingSpace(pool, SPACE_AT_LIMIT);
    expect(result.lock.waitedMs).toBeGreaterThanOrEqual(0);

    const table = embeddingSpaceTableName(SPACE_AT_LIMIT);
    const index = embeddingSpaceIndexName(SPACE_AT_LIMIT);
    expect(await regclassExists(pool, table)).toBe(true);
    expect(await regclassExists(pool, index)).toBe(true);
  }, 20_000);

  it("dimensions=2001 は拒否され、テーブルが1つも残らない", async () => {
    const pool = await createMigratedDatabase(DB_NAME);
    const table = embeddingSpaceTableName(SPACE_OVER_LIMIT);
    const index = embeddingSpaceIndexName(SPACE_OVER_LIMIT);

    await expect(registerEmbeddingSpace(pool, SPACE_OVER_LIMIT)).rejects.toThrow(
      /invalid embedding space dimensions: 2001/,
    );

    expect(await regclassExists(pool, table)).toBe(false);
    expect(await regclassExists(pool, index)).toBe(false);
  }, 20_000);
});
