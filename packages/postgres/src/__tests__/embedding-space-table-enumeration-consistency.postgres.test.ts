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
 * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
 *
 * `packages/postgres/src/embedding-space-catalog.ts` の `listEmbeddingSpaceTables`
 * （TypeScript）と `migrations/0027_erase_tenant_fk_indexes.sql` の `DO` ブロック
 * （SQL）は、**同じ3条件**（Issue #1425 / ADR 0382 決定2）を、コードとしては別の
 * 場所に2回書いている——`.sql` ファイルから TypeScript の関数を呼ぶ経路が無い
 * （`migrate.ts` は `.sql` をそのまま実行するだけ）ため、一致を機械的に強制する
 * 仕組みは無い（ADR 0383「引き受けた負債」）。
 *
 * この歯は、**両方が同じテーブル集合・同じ索引名を導くことを実測で検査する**——
 * 一致しなくなったら（どちらかを直し忘れたら）ここが赤くなる。
 *
 * ⚠ **この歯は migration ファイルの実際のテキストを `readFileSync` で読む**
 * （複製した SQL ではない）——`embedding-zero-norm-migration.postgres.test.ts` と
 * 同じ規律。列挙クエリ自体は `FOR ... IN <SELECT ...> LOOP` の `<SELECT ...>` 部分を
 * 切り出す——これは（`FOR`/`LOOP` を取り除けば）それ自体が有効な単独の SQL 文であり、
 * `DO` ブロックの外でもそのまま実行できる。索引名の一致は、DO ブロック全体
 * （`CREATE INDEX` を含む）を実行し、`pg_indexes` に実在するかで確かめる。
 */

const MIGRATION_PATH = fileURLToPath(
  new URL("../../migrations/0027_erase_tenant_fk_indexes.sql", import.meta.url),
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

/**
 * `FOR target_table, target_schema IN <SELECT ...> LOOP` から `<SELECT ...>` の
 * テキストだけを切り出す。切り出した文字列は、`FOR`/`LOOP` を取り除けば
 * そのまま独立した SQL 文として実行できる（この関数はその前提を検査しない——
 * 前提が崩れたら、この関数を呼ぶ側のクエリがそもそも構文エラーになる）。
 */
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
  // このファイルが作る埋め込み空間テーブル（SPACE_A/SPACE_B）は、他のテストファイル
  // （`erase-tenant-all-tenant-tables.postgres.test.ts` 等）が「DB に存在する全 space」を
  // 列挙する場面で漏れ残ると紛れ込む——`closeTestClient()` の前に落とす。
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

  it("両方とも、同じ空間について1バイトも違わない索引名を導く", async () => {
    const { pool } = await getTestClient();
    // 前の it に頼らず、自分で空間を登録する（`--sequence.shuffle` で it の順が入れ替わると、
    // この it が先に走り、SPACE_A/SPACE_B のテーブルがまだ無くて 0 件で落ちた。Issue #1276 / ADR 0397）。
    // `registerEmbeddingSpace` は冪等（前の it が先に走っても同じ）。
    await registerEmbeddingSpace(pool, SPACE_A);
    await registerEmbeddingSpace(pool, SPACE_B);
    for (const space of [SPACE_A, SPACE_B]) {
      const table = embeddingSpaceTableName(space);
      const tsIndexName = embeddingSpaceMemoryIdIndexName(space);
      // 索引を一旦落とし、DO ブロックに作らせてから、TS 側が計算した名前と
      // ちょうど一致する索引が実在することを確認する（名前がずれていれば、
      // DO ブロックは別名の索引を作ってしまい、この検査が0件で落ちる）。
      await pool.query(`DROP INDEX IF EXISTS ${tsIndexName}`);
      await pool.query(DO_BLOCK_SQL);
      const result = await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
        [table, tsIndexName],
      );
      expect({ table, found: result.rows.length }).toEqual({ table, found: 1 });
    }
  });

  it("3条件のうち「memory_id 列が memories(id) への FK を持つ」を満たさないテーブルは、どちらの列挙にも現れない（decoy）", async () => {
    const { db, pool } = await getTestClient();
    const decoyTable = "memory_embeddings_decoy_no_fk";
    await pool.query(`DROP TABLE IF EXISTS ${decoyTable}`);
    // `memory_embeddings_` で始まる名前・`memory_id` 列を持つが、`memories(id)` への
    // 外部キーは持たない——3条件目だけを満たさない decoy。
    await pool.query(`CREATE TABLE ${decoyTable} (tenant_id text, memory_id uuid, model text)`);

    const tsResult = await listEmbeddingSpaceTables(db);
    expect(tsResult.map((e) => e.table)).not.toContain(decoyTable);

    const sqlResult = await pool.query<{ relname: string }>(ENUMERATION_SELECT_SQL);
    expect(sqlResult.rows.map((r) => r.relname)).not.toContain(decoyTable);

    await pool.query(`DROP TABLE ${decoyTable}`);
  });
});
