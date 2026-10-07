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
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * `listEmbeddingSpaceTables`（TypeScript）と migration 0027 の `DO` ブロック（SQL）は同じ3条件を2回書いていて、
 * `.sql` から TypeScript の関数を呼ぶ経路が無いので、一致を機械的に強制する仕組みが無い。
 * この歯は、両方が同じテーブル集合・同じ索引名を導くことを実測で検査する。
 *
 * ⚠ migration ファイルの実際のテキストを `readFileSync` で読む（複製した SQL ではない）。
 * 列挙クエリは `FOR ... IN <SELECT ...> LOOP` の `<SELECT ...>` 部分を切り出す（`FOR`/`LOOP` を取り除けばそれ自体が有効な単独の SQL 文）。
 * 索引名の一致は、DO ブロック全体（`CREATE INDEX` を含む）を実行し、`pg_indexes` に実在するかで確かめる。
 */

const MIGRATION_PATH = fileURLToPath(
  new URL("../../migrations/0027_erase_tenant_fk_indexes.sql", import.meta.url),
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

/** `FOR target_table, target_schema IN <SELECT ...> LOOP` から `<SELECT ...>` のテキストだけを切り出す。 */
function extractEnumerationSelect(sqlText: string): string {
  const forMarker = "FOR target_table, target_schema IN";
  const loopMarker = "LOOP";
  const start = sqlText.indexOf(forMarker);
  if (start === -1) {
    throw new Error("migration ファイルから FOR ループの開始を見つけられなかった");
  }
  const afterFor = start + forMarker.length;
  const end = sqlText.indexOf(loopMarker, afterFor);
  if (end === -1) {
    throw new Error("migration ファイルから対応する LOOP を見つけられなかった");
  }
  return sqlText.slice(afterFor, end).trim();
}

/** 同じファイルから `DO $$ ... END $$;` のブロック全体を切り出す（索引作成まで含む）。 */
function extractDoBlock(sqlText: string): string {
  const start = sqlText.indexOf("DO $$");
  const end = sqlText.indexOf("END $$;", start);
  if (start === -1 || end === -1) {
    throw new Error("migration ファイルから DO ブロックを見つけられなかった");
  }
  return sqlText.slice(start, end + "END $$;".length);
}

const ENUMERATION_SELECT_SQL = extractEnumerationSelect(MIGRATION_SQL);
const DO_BLOCK_SQL = extractDoBlock(MIGRATION_SQL);

const SPACE_A: EmbeddingSpaceId = {
  provider: "consistency-test",
  model: "space-a",
  dimensions: 3,
};
const SPACE_B: EmbeddingSpaceId = {
  provider: "consistency-test",
  model: "space-b-with-a-very-long-model-name-that-forces-truncation-and-a-hash-suffix",
  dimensions: 5,
};

afterAll(async () => {
  // このファイルが作る埋め込み空間テーブルは、他のテストファイルが「DB に存在する全 space」を列挙する場面で漏れ残ると紛れ込むので、`closeTestClient()` の前に落とす。
  const { pool } = await getTestClient();
  await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(SPACE_A)}`);
  await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(SPACE_B)}`);
  await closeTestClient();
});

describe("listEmbeddingSpaceTables（TS）と migration 0027 の列挙（SQL）が一致する（Issue #1207 / ADR 0383）", () => {
  it("両方とも、対象の埋め込み空間テーブルを同じ集合として列挙する", async () => {
    const { db, pool } = await getTestClient();
    await registerEmbeddingSpace(pool, SPACE_A);
    await registerEmbeddingSpace(pool, SPACE_B);

    const tsResult = await listEmbeddingSpaceTables(db);
    const tsTables = new Set(tsResult.map((e) => e.table));

    const sqlResult = await pool.query<{ relname: string; nspname: string }>(
      ENUMERATION_SELECT_SQL,
    );
    const sqlTables = new Set(sqlResult.rows.map((r) => r.relname));

    expect([...tsTables].sort()).toContain(embeddingSpaceTableName(SPACE_A));
    expect([...tsTables].sort()).toContain(embeddingSpaceTableName(SPACE_B));
    expect(sqlTables).toEqual(tsTables);
  });

  async function assertIndexNamesAgreeStartingFromAnyState(): Promise<void> {
    const { pool } = await getTestClient();
    // 前の it に頼らず、自分で空間を登録する（it の順が入れ替わっても動くように。`registerEmbeddingSpace` は冪等）。
    await registerEmbeddingSpace(pool, SPACE_A);
    await registerEmbeddingSpace(pool, SPACE_B);
    for (const space of [SPACE_A, SPACE_B]) {
      const table = embeddingSpaceTableName(space);
      const tsIndexName = embeddingSpaceMemoryIdIndexName(space);
      await pool.query(`DROP INDEX IF EXISTS ${tsIndexName}`);
      await pool.query(DO_BLOCK_SQL);
      const result = await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
        [table, tsIndexName],
      );
      expect({ table, found: result.rows.length }).toEqual({ table, found: 1 });
    }
  }

  it("両方とも、同じ空間について1バイトも違わない索引名を導く", async () => {
    await assertIndexNamesAgreeStartingFromAnyState();
  });

  it("空間のテーブルがまだ無い状態から始めても、索引名は一致する（it の順を入れ替えた形。Issue #1276 / ADR 0397）", async () => {
    const { pool } = await getTestClient();
    await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(SPACE_A)}`);
    await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(SPACE_B)}`);

    await assertIndexNamesAgreeStartingFromAnyState();
  });

  it("3条件のうち「memory_id 列が memories(id) への FK を持つ」を満たさないテーブルは、どちらの列挙にも現れない（decoy）", async () => {
    const { db, pool } = await getTestClient();
    const decoyTable = "memory_embeddings_decoy_no_fk";
    await pool.query(`DROP TABLE IF EXISTS ${decoyTable}`);
    await pool.query(`CREATE TABLE ${decoyTable} (tenant_id text, memory_id uuid, model text)`);

    const tsResult = await listEmbeddingSpaceTables(db);
    expect(tsResult.map((e) => e.table)).not.toContain(decoyTable);

    const sqlResult = await pool.query<{ relname: string }>(ENUMERATION_SELECT_SQL);
    expect(sqlResult.rows.map((r) => r.relname)).not.toContain(decoyTable);

    await pool.query(`DROP TABLE ${decoyTable}`);
  });
});
