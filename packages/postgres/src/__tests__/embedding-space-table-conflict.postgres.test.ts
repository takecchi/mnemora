import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * Issue #1151: `embeddingSpaceTableName` は単射ではなく、正規化の後に同じ綴りになる空間どうしは
 * 同じテーブルに潰れる。導出は変えず、`registerEmbeddingSpace` がテーブルのコメントに空間の組を
 * 記録し、別の組が同じテーブルを登録しようとしたら拒む。
 *
 * 【実測 2026-09-27、修正前】下の4組は、どれも2つ目の登録が黙って成功し、片方の空間の
 * `search` がもう片方のベクトルを返した。
 */

const PAIRS: Array<[string, EmbeddingSpaceId, EmbeddingSpaceId]> = [
  [
    "区切りの位置が違う",
    { provider: "a_b", model: "c", dimensions: 3 },
    { provider: "a", model: "b_c", dimensions: 3 },
  ],
  [
    "大文字小文字と記号が違う",
    { provider: "openai", model: "text-embedding-3-small", dimensions: 3 },
    { provider: "OpenAI", model: "text_embedding_3_small", dimensions: 3 },
  ],
  [
    "`:` と `-` が違う",
    { provider: "ollama", model: "nomic-embed-text:latest", dimensions: 3 },
    { provider: "ollama", model: "nomic-embed-text-latest", dimensions: 3 },
  ],
  [
    "ASCII 以外の文字だけが違う",
    { provider: "x", model: "日本語モデル", dimensions: 3 },
    { provider: "x", model: "中文模型", dimensions: 3 },
  ],
];

async function dropTableOf(space: EmbeddingSpaceId): Promise<string> {
  const { pool } = await getTestClient();
  const table = embeddingSpaceTableName(space);
  await pool.query(`DROP TABLE IF EXISTS ${table}`);
  return table;
}

async function commentOf(table: string): Promise<string | null> {
  const { pool } = await getTestClient();
  const result = await pool.query<{ c: string | null }>(
    `SELECT obj_description(to_regclass($1), 'pg_class') AS c`,
    [table],
  );
  return result.rows[0]?.c ?? null;
}

async function rejectsAsConflict(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("EmbeddingSpaceTableConflictError");
  return error as Error;
}

afterAll(async () => {
  await closeTestClient();
});

describe("registerEmbeddingSpace は、同じテーブルに潰れる別の空間の登録を拒む（Issue #1151）", () => {
  beforeEach(async () => {
    for (const [, first, second] of PAIRS) {
      await dropTableOf(first);
      await dropTableOf(second);
    }
  });

  it.each(PAIRS)(
    "%s: 2つ目の組の登録は拒まれ、1つ目の組の再登録は通る",
    async (_, first, second) => {
      const { pool } = await getTestClient();
      expect(embeddingSpaceTableName(first)).toBe(embeddingSpaceTableName(second));

      await registerEmbeddingSpace(pool, first);
      const error = await rejectsAsConflict(registerEmbeddingSpace(pool, second));
      expect(error.message).toContain(JSON.stringify(first.model));
      expect(error.message).toContain(JSON.stringify(second.model));

      await expect(registerEmbeddingSpace(pool, first)).resolves.toBeDefined();
    },
  );

  it("コメントの無い既存のテーブル（修正前に作られたもの）は、最初の登録の組を記録して通す", async () => {
    const { pool } = await getTestClient();
    const [, first, second] = PAIRS[0]!;
    const table = embeddingSpaceTableName(first);
    await registerEmbeddingSpace(pool, first);
    await pool.query(`COMMENT ON TABLE ${table} IS NULL`);

    await expect(registerEmbeddingSpace(pool, second)).resolves.toBeDefined();
    expect(await commentOf(table)).toContain(JSON.stringify(second.model));
    await rejectsAsConflict(registerEmbeddingSpace(pool, first));
  });

  it("mnemora の形ではないコメント（利用者が付けたもの）は上書きせず、登録を通す", async () => {
    const { pool } = await getTestClient();
    const [, first, second] = PAIRS[1]!;
    const table = embeddingSpaceTableName(first);
    await registerEmbeddingSpace(pool, first);
    await pool.query(`COMMENT ON TABLE ${table} IS 'owned by the search team'`);

    await expect(registerEmbeddingSpace(pool, second)).resolves.toBeDefined();
    expect(await commentOf(table)).toBe("owned by the search team");
  });
});
