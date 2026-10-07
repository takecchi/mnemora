import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { listEmbeddingSpaceTables } from "../embedding-space-catalog.js";
import {
  embeddingSpaceMemoryIdIndexName,
  embeddingSpaceTableName,
} from "../embedding-space-table.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 列挙の条件は TypeScript と SQL に2回書かれていて、既存の一致の歯は本物の空間の表と decoy 1つしか見ないので、条件のうち1つを緩めても緑のまま通る。
 * そこで、条件を1つずつだけ満たさない decoy を作り、どちらの列挙にも現れないことを見る。
 * decoy は `vector_store.eraseTenant` が行を消す対象になりうる表（`tenant_id` 列を持つ）として作る。
 */

afterAll(async () => {
  await closeTestClient();
});

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("../../migrations/0027_erase_tenant_fk_indexes.sql", import.meta.url)),
  "utf8",
);

function enumerationSelect(sqlText: string): string {
  const forMarker = "FOR target_table, target_schema IN";
  const start = sqlText.indexOf(forMarker);
  const end = sqlText.indexOf("LOOP", start);
  if (start === -1 || end === -1) {
    throw new Error("migration ファイルから FOR ループを見つけられなかった");
  }
  return sqlText.slice(start + forMarker.length, end).trim();
}

function doBlock(sqlText: string): string {
  const start = sqlText.indexOf("DO $$");
  const end = sqlText.indexOf("END $$;", start);
  if (start === -1 || end === -1) {
    throw new Error("migration ファイルから DO ブロックを見つけられなかった");
  }
  return sqlText.slice(start, end + "END $$;".length);
}

const ENUMERATION_SQL = enumerationSelect(MIGRATION_SQL);
const DO_BLOCK_SQL = doBlock(MIGRATION_SQL);

const SPACE: EmbeddingSpaceId = { provider: "enum-probe", model: "space", dimensions: 3 };

const DECOYS = [
  "decoy_schema.memory_embeddings_decoy_other_schema",
  "decoy_not_prefixed",
  "memory_embeddings_decoy_other_column",
  "memory_embeddings_decoy_other_parent",
  "memory_embeddings_decoy_cross_schema_parent",
  "memory_embeddings_decoy_non_id_target",
  "memory_embeddings_decoy_composite",
];

type Pool = Awaited<ReturnType<typeof getTestClient>>["pool"];

async function createDecoys(pool: Pool): Promise<void> {
  await pool.query("CREATE SCHEMA decoy_schema");
  await pool.query("CREATE TABLE decoy_schema.memories (id uuid PRIMARY KEY, tenant_id text)");
  await pool.query(
    `CREATE TABLE decoy_schema.memory_embeddings_decoy_other_schema (
       tenant_id text, memory_id uuid REFERENCES decoy_schema.memories (id))`,
  );
  await pool.query(
    "CREATE TABLE decoy_not_prefixed (tenant_id text, memory_id uuid REFERENCES memories (id))",
  );
  await pool.query(
    `CREATE TABLE memory_embeddings_decoy_other_column (
       tenant_id text, memory_id uuid, owner_id uuid REFERENCES memories (id))`,
  );
  await pool.query(
    `CREATE TABLE memory_embeddings_decoy_other_parent (
       tenant_id text, memory_id uuid REFERENCES observations (id))`,
  );
  await pool.query(
    `CREATE TABLE memory_embeddings_decoy_cross_schema_parent (
       tenant_id text, memory_id uuid REFERENCES decoy_schema.memories (id))`,
  );
  await pool.query("ALTER TABLE memories ADD CONSTRAINT decoy_unique_hash UNIQUE (content_hash)");
  await pool.query(
    `CREATE TABLE memory_embeddings_decoy_non_id_target (
       tenant_id text, memory_id text REFERENCES memories (content_hash))`,
  );
  await pool.query(
    "ALTER TABLE memories ADD CONSTRAINT decoy_unique_id_tenant UNIQUE (id, tenant_id)",
  );
  await pool.query(
    `CREATE TABLE memory_embeddings_decoy_composite (
       tenant_id text, memory_id uuid,
       FOREIGN KEY (memory_id, tenant_id) REFERENCES memories (id, tenant_id))`,
  );
}

async function dropDecoys(pool: Pool): Promise<void> {
  for (const table of DECOYS) {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
  }
  await pool.query("DROP SCHEMA IF EXISTS decoy_schema CASCADE");
  await pool.query("ALTER TABLE memories DROP CONSTRAINT IF EXISTS decoy_unique_hash");
  await pool.query("ALTER TABLE memories DROP CONSTRAINT IF EXISTS decoy_unique_id_tenant");
}

describe("埋め込み空間の表の列挙は、条件を1つだけ満たさない表を、TypeScript 側も SQL 側も拾わない", () => {
  it("decoy は、どちらの列挙にも現れない（本物の空間の表は、どちらにも現れる）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    await registerEmbeddingSpace(pool, SPACE);
    const real = embeddingSpaceTableName(SPACE);
    try {
      await dropDecoys(pool);
      await createDecoys(pool);

      const tsTables = (await listEmbeddingSpaceTables(db)).map((e) => e.table);
      const sqlTables = (await pool.query<{ relname: string }>(ENUMERATION_SQL)).rows.map(
        (r) => r.relname,
      );

      for (const [label, tables] of [
        ["TypeScript", tsTables],
        ["SQL", sqlTables],
      ] as const) {
        expect({ label, tables: tables.filter((t) => t.includes("decoy")) }).toEqual({
          label,
          tables: [],
        });
        expect({ label, hasReal: tables.includes(real) }).toEqual({ label, hasReal: true });
      }
    } finally {
      await dropDecoys(pool);
      await pool.query(`DROP TABLE IF EXISTS ${real}`);
    }
  }, 60_000);

  it("DO ブロックが遡って作る索引は、memory_id だけの単一列で、部分索引ではなく、registerEmbeddingSpace が作る索引と同じ形である", async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    await registerEmbeddingSpace(pool, SPACE);
    const real = embeddingSpaceTableName(SPACE);
    const index = embeddingSpaceMemoryIdIndexName(SPACE);
    const shape = async () => {
      const r = await pool.query<{ cols: string[]; partial: boolean }>(
        `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols, (i.indpred IS NOT NULL) AS partial
         FROM pg_class ic
         JOIN pg_index i ON i.indexrelid = ic.oid
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE ic.relname = $1
         GROUP BY i.indpred`,
        [index],
      );
      return r.rows;
    };
    try {
      const viaRegister = await shape();
      expect(viaRegister).toEqual([{ cols: ["memory_id"], partial: false }]);

      await pool.query(`DROP INDEX ${index}`);
      await pool.query(DO_BLOCK_SQL);
      expect(await shape()).toEqual(viaRegister);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${real}`);
    }
  }, 60_000);
});
