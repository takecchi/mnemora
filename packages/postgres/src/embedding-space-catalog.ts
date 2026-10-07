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
 * `current_schema()` の中で、埋め込み空間のテーブル（`memory_embeddings_<space>`）を列挙する
 * （[ADR 0382](../../../docs/decisions/0382-vector-store-delete-across-spaces.md) 決定2の3条件）:
 *
 * 1. `current_schema()` の中のテーブルだけ（スキーマを跨がない）。
 * 2. テーブル名が {@link EMBEDDING_SPACE_TABLE_PREFIX} で始まる。
 * 3. `memory_id` 列が、同じスキーマの `memories(id)` を外部キーで参照している
 *    （利用者が同じ命名慣習で作った無関係なテーブルを巻き込まない）。
 *
 * `migrations/0027_erase_tenant_fk_indexes.sql` の `DO` ブロックも同じ列挙をする。migration は SQL を
 * そのまま実行するだけでこの関数を呼べないので、同じ3条件を SQL として書き写してある。一致を強制する
 * 仕組みは無く、テストが検出するだけ（ADR 0383「引き受けた負債」）。
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
      AND fkatt.attname = 'memory_id'
      AND refc.relname = 'memories'
      AND refn.nspname = n.nspname
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
