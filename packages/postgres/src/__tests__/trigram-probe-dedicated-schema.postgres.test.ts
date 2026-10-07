import type { Ctx } from "@mnemora/core";
import { Client as PgClient, Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import {
  PostgresTrigramLexicalStore,
  TrigramLexicalStoreUnavailableError,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 専用スキーマの構成で `probeTrigramLexicalSupport` が `pg_trgm` をどこに入れるかを縛る歯。
 *
 * ## 振る舞い
 *
 * `probeTrigramLexicalSupport`（`PostgresTrigramLexicalStore.create` が内部で呼ぶ）の
 * `CREATE EXTENSION IF NOT EXISTS pg_trgm` は、`vector` 拡張（`runMigrations` が
 * `REQUIRED_EXTENSIONS` として `extensionSchema` に入れたもの）のスキーマを読み、そこへ
 * `WITH SCHEMA` で入れる——`vector` が見つからない、またはそのスキーマが現在の
 * `search_path` の先頭（`current_schema()`）と同じとき（`schema` を渡さない既定の構成で、
 * `vector` が先頭のスキーマに在る場合）は、発行する SQL 文字列を変えない。
 *
 * 作った（または既にあった）`pg_trgm` が、この接続の `search_path` から見えなければ、
 * `{ ok: false, reason: "extension_not_visible", detail }` を返す（`detail` は拡張が実際に
 * 入っているスキーマ名）。`create()` はこれを `TrigramLexicalStoreUnavailableError` にして
 * 投げる——素の DB の例外（`42883`）はもう出ない。
 *
 * 以下の歯:
 * (a) 新しく作る DB（既定の `extensionSchema` = `public`）: `ns_a`・`ns_b` とも
 *     `{ ok: true }`。`pg_trgm` は `public` に入り、`create`/`search` も通る。
 * (a2) `extensionSchema` にカスタムな名前（`public` 以外）を渡しても、その名前へ入る。
 * (b) 既に別の名前空間（`ns_a`）へ `pg_trgm` が手動で入ってしまった DB: `ns_a` は `{ ok: true }`。`ns_b` は
 *     `{ ok: false, reason: "extension_not_visible", detail: "ns_a" }`。`create` は同じ
 *     `reason` を持つ `TrigramLexicalStoreUnavailableError` を投げる。
 * (c) (b) の後に `ALTER EXTENSION pg_trgm SET SCHEMA public` を流せば、両方 `{ ok: true }`
 *     になる。
 * (d) 既定の構成（`schema` を渡さない）では、発行される SQL 文字列が変わらないことを、
 *     実際に発行された SQL を記録して確かめる。
 * (e) 既定の構成でも、`vector` が `search_path` の先頭以外のスキーマ（`assertSafeSchemaName`
 *     を通らない名前）に在れば、`pg_trgm` はそこへ入り `{ ok: true }` になる。
 */

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}
function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function extensionSchemasOf(pool: Pool, extname: string): Promise<string[]> {
  const { rows } = await pool.query<{ nspname: string }>(
    `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = $1`,
    [extname],
  );
  return rows.map((r) => r.nspname);
}

/**
 * `pool.query` を横取りし、`pg_trgm` を含む文だけを記録する。**必ずオリジナルの実装を
 * 呼び直す**——結果を偽造しない。`vi.spyOn(...).mockImplementation` は `Pool#query` の
 * オーバーロードと噛み合わせにくいため、代入して復元する素朴な形にしてある。
 */
function captureCreateExtensionSql(): { texts: string[]; restore: () => void } {
  // probe は `db.transaction`（専用の接続）の中で流れるので、`pool.query` ではなく
  // `pg.Client.prototype.query` を見る。
  const original = PgClient.prototype.query as unknown as (...args: unknown[]) => unknown;
  const texts: string[] = [];
  PgClient.prototype.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
    if (typeof text === "string" && /^\s*CREATE EXTENSION\b/i.test(text)) {
      texts.push(text.trim());
    }
    return original.apply(this, args);
  } as unknown as PgClient["query"];
  return {
    texts,
    restore: () => {
      PgClient.prototype.query = original as unknown as PgClient["query"];
    },
  };
}

/** SQL_ASCII/C クラスタでは `pg_trgm` 自体が作られないため、その脚をここでまとめて弾く。 */
async function isUtf8(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ server_encoding: string }>("SHOW server_encoding");
  return rows[0]!.server_encoding.toUpperCase() === "UTF8";
}

async function assertSearchWorks(db: ReturnType<typeof createPostgresClient>["db"]): Promise<void> {
  const store = await PostgresTrigramLexicalStore.create(db);
  const ctx: Ctx = { tenantId: "trigram-probe-schema-tenant" };
  await expect(
    store.search(ctx, "query", { limit: 5, filter: { tenantId: ctx.tenantId } }),
  ).resolves.toEqual([]);
}

afterAll(async () => {
  await adminPool?.end();
});

describe("probeTrigramLexicalSupport と専用スキーマ（Issue #1256 修正後の振る舞い）", () => {
  describe("(a) 新しく作る DB", () => {
    const DB = "mnemora_trgm_probe_schema_fresh";

    afterAll(async () => {
      await dropTempDatabase(admin(), DB);
    });

    it("既定の extensionSchema（public）: ns_a・ns_b とも ok:true、pg_trgm は public に入り create/search も通る", async () => {
      await dropTempDatabase(admin(), DB);
      await admin().query(`CREATE DATABASE ${DB}`);
      const clients = ["ns_a", "ns_b"].map((schema) => ({
        schema,
        client: createPostgresClient(connectionStringFor(DB), { schema, max: 2 }),
      }));
      try {
        const utf8 = await isUtf8(clients[0]!.client.pool);
        for (const { schema, client } of clients) {
          await runMigrations(client.pool, undefined, { schema });
        }
        if (!utf8) {
          for (const { client } of clients) {
            expect(await probeTrigramLexicalSupport(client.db)).toMatchObject({
              ok: false,
              reason: "server_encoding_not_utf8",
            });
          }
          return;
        }

        for (const { client } of clients) {
          expect(await probeTrigramLexicalSupport(client.db)).toEqual({ ok: true });
        }
        expect(await extensionSchemasOf(clients[0]!.client.pool, "pg_trgm")).toEqual(["public"]);

        for (const { client } of clients) {
          await assertSearchWorks(client.db);
        }
      } finally {
        for (const { client } of clients) await closePostgresClient(client);
      }
    });

    it("カスタムな extensionSchema（public 以外）へも pg_trgm が入る", async () => {
      await dropTempDatabase(admin(), DB);
      await admin().query(`CREATE DATABASE ${DB}`);
      // extensionSchema には ns_a（先に作る schema）を使い回す——`CREATE EXTENSION ...
      // WITH SCHEMA` は対象スキーマが既に存在していることを前提にするため
      // （`migrate.ts` は `extensionSchema` 専用の `CREATE SCHEMA` を発行しない）。
      const a = {
        schema: "ns_a",
        client: createPostgresClient(connectionStringFor(DB), {
          schema: "ns_a",
          extensionSchema: "ns_a",
          max: 2,
        }),
      };
      const b = {
        schema: "ns_b",
        client: createPostgresClient(connectionStringFor(DB), {
          schema: "ns_b",
          extensionSchema: "ns_a",
          max: 2,
        }),
      };
      try {
        const utf8 = await isUtf8(a.client.pool);
        await runMigrations(a.client.pool, undefined, {
          schema: a.schema,
          extensionSchema: "ns_a",
        });
        await runMigrations(b.client.pool, undefined, {
          schema: b.schema,
          extensionSchema: "ns_a",
        });
        if (!utf8) {
          expect(await probeTrigramLexicalSupport(a.client.db)).toMatchObject({
            ok: false,
            reason: "server_encoding_not_utf8",
          });
          return;
        }

        expect(await probeTrigramLexicalSupport(a.client.db)).toEqual({ ok: true });
        expect(await probeTrigramLexicalSupport(b.client.db)).toEqual({ ok: true });
        expect(await extensionSchemasOf(a.client.pool, "pg_trgm")).toEqual(["ns_a"]);
        await assertSearchWorks(a.client.db);
        await assertSearchWorks(b.client.db);
      } finally {
        await closePostgresClient(a.client);
        await closePostgresClient(b.client);
      }
    });
  });

  describe("(b)+(c) 既に別の名前空間に pg_trgm が入った DB", () => {
    const DB = "mnemora_trgm_probe_schema_broken";

    afterAll(async () => {
      await dropTempDatabase(admin(), DB);
    });

    it("ns_b は extension_not_visible で落ち、ALTER EXTENSION ... SET SCHEMA public の後は両方 ok:true になる", async () => {
      await dropTempDatabase(admin(), DB);
      await admin().query(`CREATE DATABASE ${DB}`);
      const clients = ["ns_a", "ns_b"].map((schema) => ({
        schema,
        client: createPostgresClient(connectionStringFor(DB), { schema, max: 2 }),
      }));
      try {
        const utf8 = await isUtf8(clients[0]!.client.pool);
        for (const { schema, client } of clients) {
          await runMigrations(client.pool, undefined, { schema });
        }
        if (!utf8) {
          return;
        }

        const [a, b] = clients;
        // 別の名前空間に pg_trgm が入っている DB を作る——pg_trgm を ns_a に手動で入れておく。
        await a!.client.pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA "ns_a"`);
        expect(await extensionSchemasOf(a!.client.pool, "pg_trgm")).toEqual(["ns_a"]);

        expect(await probeTrigramLexicalSupport(a!.client.db)).toEqual({ ok: true });

        expect(await probeTrigramLexicalSupport(b!.client.db)).toEqual({
          ok: false,
          reason: "extension_not_visible",
          detail: "ns_a",
        });
        await expect(PostgresTrigramLexicalStore.create(b!.client.db)).rejects.toMatchObject({
          name: "TrigramLexicalStoreUnavailableError",
          reason: "extension_not_visible",
          detail: "ns_a",
        });
        await expect(PostgresTrigramLexicalStore.create(b!.client.db)).rejects.toBeInstanceOf(
          TrigramLexicalStoreUnavailableError,
        );
        expect(await extensionSchemasOf(a!.client.pool, "pg_trgm")).toEqual(["ns_a"]);

        // (c) 直し方: 拡張の権限を持つロールで ALTER EXTENSION ... SET SCHEMA。
        // `admin()` は既定の DB（`DATABASE_URL` が指すもの）に繋がっており、この使い捨て
        // DB（`DB`）には繋がっていない——同じ DB に繋がっている `a!.client.pool` で流す。
        await a!.client.pool.query(`ALTER EXTENSION pg_trgm SET SCHEMA public`);
        expect(await extensionSchemasOf(a!.client.pool, "pg_trgm")).toEqual(["public"]);
        expect(await probeTrigramLexicalSupport(a!.client.db)).toEqual({ ok: true });
        expect(await probeTrigramLexicalSupport(b!.client.db)).toEqual({ ok: true });
      } finally {
        for (const { client } of clients) await closePostgresClient(client);
      }
    });
  });

  describe("(d) 既定の構成（schema を渡さない）", () => {
    const DB = "mnemora_trgm_probe_schema_default";

    afterAll(async () => {
      await dropTempDatabase(admin(), DB);
    });

    it("発行される CREATE EXTENSION の SQL 文字列は、今日と1バイトも変わらない", async () => {
      await dropTempDatabase(admin(), DB);
      await admin().query(`CREATE DATABASE ${DB}`);
      const client = createPostgresClient(connectionStringFor(DB), { max: 2 });
      try {
        const utf8 = await isUtf8(client.pool);
        await runMigrations(client.pool);
        if (!utf8) {
          return;
        }

        const { texts, restore } = captureCreateExtensionSql();
        try {
          expect(await probeTrigramLexicalSupport(client.db)).toEqual({ ok: true });
        } finally {
          restore();
        }
        expect(texts).toEqual(["CREATE EXTENSION IF NOT EXISTS pg_trgm"]);
      } finally {
        await closePostgresClient(client);
      }
    });
  });

  describe("(e) 既定の構成で、vector が search_path の先頭以外のスキーマに在る", () => {
    const DB = "mnemora_trgm_probe_schema_vector_elsewhere";
    // 大文字と記号を含む——mnemora の `assertSafeSchemaName` を通らない名前。利用者が
    // 自分で `vector` をこういうスキーマに置いていても、probe は落ちずにそこへ合わせる。
    const VECTOR_SCHEMA = 'Ext-"Schema"';
    const quoted = `"${VECTOR_SCHEMA.replace(/"/g, '""')}"`;

    afterAll(async () => {
      await dropTempDatabase(admin(), DB);
    });

    it("pg_trgm は vector と同じスキーマに入り、ok:true になる", async () => {
      await dropTempDatabase(admin(), DB);
      await admin().query(`CREATE DATABASE ${DB}`);
      await admin().query(`ALTER DATABASE ${DB} SET search_path = public, ${quoted}`);
      const client = createPostgresClient(connectionStringFor(DB), { max: 2 });
      try {
        await client.pool.query(`CREATE SCHEMA ${quoted}`);
        await client.pool.query(`CREATE EXTENSION vector WITH SCHEMA ${quoted}`);
        const utf8 = await isUtf8(client.pool);
        await runMigrations(client.pool);
        if (!utf8) {
          return;
        }

        expect(await probeTrigramLexicalSupport(client.db)).toEqual({ ok: true });
        expect(await extensionSchemasOf(client.pool, "pg_trgm")).toEqual([VECTOR_SCHEMA]);
        await assertSearchWorks(client.db);
      } finally {
        await closePostgresClient(client);
      }
    });
  });
});
