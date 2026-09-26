import type { Pool } from "pg";

/**
 * `schema` オプションを省略した呼び出しが実際に見ているスキーマを、同じ `pool` に対する
 * `SELECT current_schema()` で読む（Issue #779）。
 *
 * ## 何のためにあるか
 *
 * `migrationLockKeyFor`（`./migrate.ts`） / `registerEmbeddingSpaceLockKeyFor`
 * （`./vector-space.ts`）は同期関数で、DB 接続を持たない——`schema` 未指定のときに
 * 実際どのスキーマが使われるかを、それ自身では特定できない（PostgreSQL の既定
 * `search_path` は `"$user", public` であり、接続ロール名と同じ名前のスキーマが
 * DB に在れば `"$user"` がそちらへ解決される。Issue #757 の実測）。この関数は、
 * その解決結果を `runMigrations` / `registerEmbeddingSpace` がロックキーを選ぶ**前**に
 * 読むための、唯一の口である。
 *
 * `current_schema()` が `NULL` を返す（`search_path` に列挙したどのスキーマも
 * 存在しない）場合は `undefined` を返す——呼び出し側はこれを「未指定のまま」と同じに
 * 扱い、`migrationLockKeyFor(undefined)` / `registerEmbeddingSpaceLockKeyFor(undefined)`
 * （＝既存の固定キー）へ落ちる。
 *
 * **`assertSafeSchemaName`（`./schema-namespace.ts`）を通さない。** ここで読んだ値は
 * advisory lock のキーを導出する `deriveAdvisoryLockKey` の seed 文字列に混ぜるだけであり、
 * SQL 識別子として組み立て直すことはしない——不正な形の名前（実際には起こり得ないが）が
 * 来ても、ハッシュの入力が変わるだけで例外にはならない。
 *
 * ## `./schema-namespace.ts` に置かず、別ファイルに切り出した理由
 *
 * `packages/postgres/src/index.ts` は `export * from "./schema-namespace.js"` で
 * `schema-namespace.ts` の公開関数をそのまま外部へ再輸出する。この関数は
 * `runMigrations` / `registerEmbeddingSpace` の advisory lock キー選びのためだけの
 * 内部 helper であり、**公開 API の一部にしない**（`migrationLockKeyFor` /
 * `registerEmbeddingSpaceLockKeyFor` のシグネチャ・戻り値を変えないという線と同じ理由——
 * `pnpm api:check` の公開型シグネチャ snapshot に載せない）。そのため `schema-namespace.ts`
 * とは別のファイルに置き、`index.ts` からは export しない。
 */
export async function resolveCurrentSchema(pool: Pool): Promise<string | undefined> {
  const { rows } = await pool.query<{ current_schema: string | null }>("SELECT current_schema()");
  const value = rows[0]?.current_schema;
  return value === null || value === undefined ? undefined : value;
}
