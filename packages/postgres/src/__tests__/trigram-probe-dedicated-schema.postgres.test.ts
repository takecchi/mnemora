import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 専用スキーマの構成で `probeTrigramLexicalSupport` が `pg_trgm` をどこに入れるかの今の振る舞いを縛る
 * （Issue #1256。`probeTrigramLexicalSupport` の doc の 2026-09-28 追記）。振る舞いは変えていない。
 *
 * `pg_trgm` がまだ無い使い捨ての DB に、名前空間を2つ用意して順に probe する。
 * 1. 1つ目は `{ ok: true }` で、`pg_trgm` は `extensionSchema`（`public`）ではなく1つ目の名前空間に入る。
 * 2. 2つ目は `{ ok: false, reason }` を返さず、`word_similarity` が見えない DB の例外を投げる。
 *    `PostgresTrigramLexicalStore.create` も同じ例外を投げる（`TrigramLexicalStoreUnavailableError` ではない）。
 * `server_encoding` が `UTF8` でないクラスタでは、probe が最初の検査で `server_encoding_not_utf8` を返し
 * `pg_trgm` を作らないので、その振る舞いだけを確かめる。
 */

const DB = "mnemora_trgm_probe_schema";
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

afterAll(async () => {
  await dropTempDatabase(admin(), DB);
  await adminPool?.end();
});

describe("probeTrigramLexicalSupport と専用スキーマ（今の振る舞い）", () => {
  it("pg_trgm は1つ目の名前空間に入り、2つ目の名前空間では名前の付かない例外になる", async () => {
    await dropTempDatabase(admin(), DB);
    await admin().query(`CREATE DATABASE ${DB}`);
    const clients = ["ns_a", "ns_b"].map((schema) => ({
      schema,
      client: createPostgresClient(connectionStringFor(DB), { schema, max: 2 }),
    }));
    try {
      const { rows } = await clients[0]!.client.pool.query<{ server_encoding: string }>(
        "SHOW server_encoding",
      );
      const utf8 = rows[0]!.server_encoding.toUpperCase() === "UTF8";
      for (const { schema, client } of clients) {
        await runMigrations(client.pool, undefined, { schema });
      }
      const [a, b] = clients;
      const extensionSchemas = async () =>
        (
          await a!.client.pool.query<{ nspname: string }>(
            `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_trgm'`,
          )
        ).rows.map((r) => r.nspname);

      if (!utf8) {
        for (const { client } of clients) {
          expect(await probeTrigramLexicalSupport(client.db)).toMatchObject({
            ok: false,
            reason: "server_encoding_not_utf8",
          });
        }
        expect(await extensionSchemas()).toEqual([]);
        return;
      }

      expect(await probeTrigramLexicalSupport(a!.client.db)).toEqual({ ok: true });
      expect(await extensionSchemas()).toEqual(["ns_a"]);

      const rejects = async (p: Promise<unknown>) => {
        const error = await p.then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).not.toBeNull();
        const cause = (error as { cause?: { code?: string } }).cause;
        expect(cause?.code).toBe("42883");
      };
      await rejects(probeTrigramLexicalSupport(b!.client.db));
      await rejects(PostgresTrigramLexicalStore.create(b!.client.db));
      expect(await extensionSchemas()).toEqual(["ns_a"]);
    } finally {
      for (const { client } of clients) await closePostgresClient(client);
    }
  });
});
