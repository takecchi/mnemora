import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * 衝突の歯が schema 未指定（public）しか見ていないと、テーブルのコメントを読む `to_regclass` が schema で修飾されていなくても気づけない。
 * 修飾されていないと `search_path` の側（public）を引いて「コメントが無い」と読み、2つ目の登録が通ってコメントを上書きする。
 * この歯は、専用スキーマの側でも2つ目が拒まれ、コメントが1つ目の組のままであることを縛る。
 */

const SCHEMA = "mnemora_conflict_schema_probe";

const FIRST: EmbeddingSpaceId = { provider: "zz_schema_a", model: "probe-model", dimensions: 3 };
const SECOND: EmbeddingSpaceId = { provider: "zz-schema-a", model: "probe-model", dimensions: 3 };

/** `schema` 修飾付きのテーブルのコメント。`to_regclass` へ渡す名前は修飾する（`::text` の一致は使わない）。 */
async function commentInSchema(table: string): Promise<string | null> {
  const { pool } = await getTestClient();
  const result = await pool.query<{ c: string | null }>(
    `SELECT obj_description(to_regclass($1), 'pg_class') AS c`,
    [`"${SCHEMA}"."${table}"`],
  );
  return result.rows[0]?.c ?? null;
}

async function existsInPublic(table: string): Promise<boolean> {
  const { pool } = await getTestClient();
  const result = await pool.query<{ found: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS found`,
    [`"public"."${table}"`],
  );
  return result.rows[0]?.found === true;
}

beforeAll(async () => {
  const { pool } = await getTestClient();
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });
});

afterAll(async () => {
  const { pool } = await getTestClient();
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await closeTestClient();
});

describe("registerEmbeddingSpace は、専用スキーマでも、同じテーブルに潰れる別の空間の登録を拒む（Issue #1151）", () => {
  it("2つ目の組の登録は拒まれ、コメントは1つ目の組のままで、1つ目の再登録は通る", async () => {
    const { pool } = await getTestClient();
    const table = embeddingSpaceTableName(FIRST);
    expect(embeddingSpaceTableName(SECOND)).toBe(table);
    // 取り違えの対照: public 側には同名のテーブルを作らない（public を引いても何も読めない状況にする）。
    expect(await existsInPublic(table)).toBe(false);

    await registerEmbeddingSpace(pool, FIRST, { schema: SCHEMA });
    const firstComment = await commentInSchema(table);
    expect(firstComment).toContain(JSON.stringify(FIRST.provider));

    const error = await registerEmbeddingSpace(pool, SECOND, { schema: SCHEMA }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("EmbeddingSpaceTableConflictError");

    expect(await commentInSchema(table)).toBe(firstComment);
    expect(await existsInPublic(table)).toBe(false);
    await expect(registerEmbeddingSpace(pool, FIRST, { schema: SCHEMA })).resolves.toBeDefined();
  });
});
