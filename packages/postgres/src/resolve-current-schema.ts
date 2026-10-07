import type { Pool } from "pg";

/**
 * `schema` を省略した呼び出しが実際に見ているスキーマを、同じ `pool` で `SELECT current_schema()` して読む。
 * `current_schema()` が `NULL` なら `undefined`（呼び出し側は未指定と同じに扱う）。
 *
 * `migrationLockKeyFor` / `registerEmbeddingSpaceLockKeyFor` は同期関数で接続を持たず、省略時の解決先を
 * 知らない（既定の `search_path` は `"$user", public` で、ロール名のスキーマがあればそちらになる）。
 * lock キーを選ぶ前に解決先を読むための口がこれ。
 *
 * `assertSafeSchemaName` は通さない。値は lock キーの seed に混ぜるだけで、SQL 識別子には組み立てない。
 *
 * `schema-namespace.ts` に置かない: `index.ts` が `export *` で再輸出するので、置くと内部 helper が公開 API に載る。
 */
export async function resolveCurrentSchema(pool: Pool): Promise<string | undefined> {
  const { rows } = await pool.query<{ current_schema: string | null }>("SELECT current_schema()");
  const value = rows[0]?.current_schema;
  return value === null || value === undefined ? undefined : value;
}
