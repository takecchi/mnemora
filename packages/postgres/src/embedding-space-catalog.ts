import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { EMBEDDING_SPACE_TABLE_PREFIX } from "./embedding-space-table.js";

/** 1本の埋め込み空間テーブル（`memory_embeddings_<space>`）の所在。 */
export interface EmbeddingSpaceCatalogEntry {
  /** テーブル名（`pg_class.relname`）。 */
  table: string;
  /** テーブルが属するスキーマ名（`pg_namespace.nspname`）。 */
  schema: string;
}

/**
 * `current_schema()` の中で、埋め込み空間のテーブル（`memory_embeddings_<space>`）を
 * 列挙する（Issue #1425 / [ADR 0382](../../../docs/decisions/0382-vector-store-delete-across-spaces.md)
 * 決定2が定めた3条件）:
 *
 * 1. **`current_schema()` の中のテーブルだけ**——スキーマを跨がない。
 * 2. **テーブル名が {@link EMBEDDING_SPACE_TABLE_PREFIX}（`memory_embeddings_`）で始まる。**
 * 3. **`memory_id` 列が、同じスキーマの `memories(id)` を外部キーで参照している**
 *    ——利用者が同じ命名慣習で作った無関係なテーブルを巻き込まない。
 *
 * `registerEmbeddingSpace`（`vector-space.ts`）が作るテーブルは、この3条件をすべて
 * 満たす（`tenant_id`/`memory_id` の複合主キー、`memory_id uuid NOT NULL
 * REFERENCES memories(id)`）。
 *
 * **この列挙は3箇所で使われる**（Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md)
 * が、Issue #1425 の時点で1箇所だった列挙を共通化した）:
 * - `PostgresVectorStore.deleteAcrossSpaces`（Issue #1425）
 * - `PostgresVectorStore.eraseTenant?`（Issue #1207）
 * - `migrations/0027_erase_tenant_fk_indexes.sql` の `DO` ブロック（既存の空間へ
 *   `(memory_id)` の索引を遡って足す）——**ただし migration は手書きの SQL であり、
 *   この TypeScript 関数を呼べない**（`migrate.ts` は `.sql` ファイルをそのまま実行する
 *   だけで、SQL から TypeScript の関数を呼ぶ経路が無い）。migration 側は同じ3条件を
 *   SQL として書き写しており、`packages/postgres/src/__tests__/
 *   embedding-space-table-enumeration-consistency.postgres.test.ts` が、この関数の
 *   結果と migration の `DO` ブロックが使う列挙クエリの結果が一致することを実測で
 *   固定している——**一致を機械的に強制する仕組みは無く、歯が検出するだけ**
 *   （ADR 0383「引き受けた負債」参照）。
 */
export async function listEmbeddingSpaceTables(tx: Db): Promise<EmbeddingSpaceCatalogEntry[]> {
  const result = await tx.execute(sql`
    SELECT c.relname AS table_name, n.nspname AS schema_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class refc ON refc.oid = con.confrelid
    JOIN pg_namespace refn ON refn.oid = refc.relnamespace
    JOIN pg_attribute fkatt
      ON fkatt.attrelid = con.conrelid AND fkatt.attnum = con.conkey[1]
    JOIN pg_attribute pkatt
      ON pkatt.attrelid = con.confrelid AND pkatt.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND n.nspname = current_schema()
      AND starts_with(c.relname, ${EMBEDDING_SPACE_TABLE_PREFIX})
      AND array_length(con.conkey, 1) = 1
      AND pkatt.attname = 'id'
  `);
  return result.rows.map((row) => {
    const { table_name: table, schema_name: schema } = row as unknown as {
      table_name: string;
      schema_name: string;
    };
    return { table, schema };
  });
}
