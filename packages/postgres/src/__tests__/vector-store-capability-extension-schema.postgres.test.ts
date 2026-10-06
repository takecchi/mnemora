import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `PostgresVectorStore.search()`/`searchMany()` の pgvector 能力検査
 * （`PgvectorCapabilityGate`、ADR 0367）は、`vector` を `public` 以外の `extensionSchema` に置き、
 * `createPostgresClient({ schema, extensionSchema })` で作った db でも通らなければならない
 * （Issue #1780 の `runMigrations` 側と同じ条件を、`vector-store.ts` 側で確かめる歯）。
 *
 * `PostgresVectorStore` は `db` だけを受け取り、`schema`/`extensionSchema` は知らない。検査の SQL
 * （`'[0]'::vector`）は型を修飾せず、その接続の `search_path` のまま流れる。`search_path` は
 * `createPostgresClient` が接続の起動オプション（`-c search_path=<schema>,<extensionSchema>`、
 * ADR 0057）として載せるので、検査にも `extensionSchema` が見える。この歯はそれを縛る。
 *
 * 対照: 同じ DB を `search_path` に手を加えない db（`createPostgresClient(url)`）で引くと、
 * 検査の有無に関わらず `vector` が解決できず落ちる（検索の SQL 本体が `vector` 型・演算子を使うため）。
 * 落ちるのが能力検査ではないことは、検査を外す変異で確かめてある（ADR 0367 追記）。
 */

const DATABASE = "mnemora_vs_capext";
const EXT_SCHEMA = "mnemora_ext_vs";
const SCHEMA = "mnemora_app_vs";
const SPACE: EmbeddingSpaceId = { provider: "test", model: "capext", dimensions: 3 };
const ctx: Ctx = { tenantId: "tenant-vs-capext" };
const filter = { tenantId: ctx.tenantId };

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function urlFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

describe("PostgresVectorStore: pgvector 能力検査と extensionSchema", () => {
  afterAll(async () => {
    await dropTempDatabase(admin(), DATABASE);
    await adminPool?.end();
  });

  it("extensionSchema（public 以外）を渡した client の search/searchMany は、能力検査を通って結果を返す", async () => {
    await dropTempDatabase(admin(), DATABASE);
    await admin().query(`CREATE DATABASE ${DATABASE}`);
    const setup = new Pool({ connectionString: urlFor(DATABASE), max: 1 });
    try {
      await setup.query(`CREATE SCHEMA "${EXT_SCHEMA}"`);
      for (const ext of ["vector", "btree_gin", "pgcrypto"]) {
        await setup.query(`CREATE EXTENSION ${ext} WITH SCHEMA "${EXT_SCHEMA}"`);
      }
      const options = { schema: SCHEMA, extensionSchema: EXT_SCHEMA } as const;
      await runMigrations(setup, undefined, options);
      await registerEmbeddingSpace(setup, SPACE, options);
    } finally {
      await setup.end();
    }

    const main = createPostgresClient(urlFor(DATABASE), {
      schema: SCHEMA,
      extensionSchema: EXT_SCHEMA,
    });
    try {
      const memory = await new PostgresMemoryStore(main.db).createMemory(
        ctx,
        buildNewMemoryFixture({ contentHash: "fixture-hash-vs-capext" }),
      );
      await new PostgresVectorStore(main.db).upsert(ctx, SPACE, memory.id, [1, 0, 0]);

      // インスタンスごとに能力検査のキャッシュを持つので、メソッドごとに新しいインスタンスを使い、
      // search・searchMany の両方で検査が流れることを確かめる。
      const hits = await new PostgresVectorStore(main.db).search(ctx, SPACE, [1, 0, 0], {
        limit: 5,
        filter,
      });
      expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);

      const many = await new PostgresVectorStore(main.db).searchMany(
        ctx,
        SPACE,
        [{ key: "q", vector: [1, 0, 0] }],
        { limit: 5, filter },
      );
      expect(many.get("q")!.map((h) => h.memoryId)).toEqual([memory.id]);
    } finally {
      await closePostgresClient(main);
    }

    // 対照: search_path に手を加えない db は、同じ DB を引けない（`schema` の表も `vector` 型も見えない）。
    // 「主経路が通る」のは接続の `search_path` のおかげであって、この DB が何でも通すからではない。
    const plain = createPostgresClient(urlFor(DATABASE));
    try {
      await expect(
        new PostgresVectorStore(plain.db).search(ctx, SPACE, [1, 0, 0], { limit: 5, filter }),
      ).rejects.toThrow();
      await expect(
        new PostgresVectorStore(plain.db).searchMany(
          ctx,
          SPACE,
          [{ key: "q", vector: [1, 0, 0] }],
          {
            limit: 5,
            filter,
          },
        ),
      ).rejects.toThrow();
    } finally {
      await closePostgresClient(plain);
    }
  });
});
