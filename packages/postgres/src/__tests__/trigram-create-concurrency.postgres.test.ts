import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { EXTENSION_LOCK_KEY, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * ADR 0430 決定1: `PostgresTrigramLexicalStore.create()`（と、公開の `probeTrigramLexicalSupport`）の
 * 同時呼び出しは、`migrate.ts` の `EXTENSION_LOCK_KEY` の advisory lock（トランザクション内の
 * `pg_advisory_xact_lock`）で直列になる。
 *
 * 直す前の実測（別々の pool から同時に呼ぶ）:
 * - 拡張が無い DB: `CREATE EXTENSION IF NOT EXISTS pg_trgm` が 23505（`pg_extension_name_index`）で
 *   落ち、`TrigramLexicalStoreUnavailableError(extension_create_failed)` になる。
 * - 拡張も関数も在る DB: `CREATE OR REPLACE FUNCTION` が XX000（`tuple concurrently updated`）で落ち、
 *   素の `Error` になる。
 *
 * このファイルは `CREATE DATABASE` で自分専用の DB を作って使う。
 */

const BASE = "mnemora_trgm_create_conc";
const POOLS = 4;

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

afterAll(async () => {
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
});

/**
 * SQL_ASCII のクラスタでは `pg_trgm` を日本語の語彙照合に使えない（`server_encoding_not_utf8`）ので、
 * この脚は飛ばす（`trigram-probe-dedicated-schema.postgres.test.ts` の `isUtf8` と同じ扱い）。
 */
async function isUtf8(): Promise<boolean> {
  const { rows } = await admin().query<{ server_encoding: string }>("SHOW server_encoding");
  return rows[0]!.server_encoding.toUpperCase() === "UTF8";
}

async function withFreshDatabase<T>(
  name: string,
  body: (clients: PostgresClient[]) => Promise<T>,
): Promise<T> {
  await dropTempDatabase(admin(), name);
  await admin().query(`CREATE DATABASE ${name}`);
  const clients: PostgresClient[] = [];
  try {
    for (let i = 0; i < POOLS; i++) {
      clients.push(createPostgresClient(connectionStringFor(name)));
    }
    await runMigrations(clients[0]!.pool);
    return await body(clients);
  } finally {
    for (const c of clients) {
      await closePostgresClient(c);
    }
    await dropTempDatabase(admin(), name);
  }
}

function failures(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((r) =>
    r.status === "rejected"
      ? [`${(r.reason as Error).name}: ${String((r.reason as Error).message).slice(0, 160)}`]
      : [],
  );
}

describe("PostgresTrigramLexicalStore.create() の同時呼び出し（ADR 0430）", () => {
  it("(a) pg_trgm が無い DB へ、別々の pool から同時に create() しても全部成功する", async () => {
    if (!(await isUtf8())) return;
    for (let trial = 0; trial < 5; trial++) {
      await withFreshDatabase(`${BASE}_a`, async (clients) => {
        const ext = await clients[0]!.pool.query(
          `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
        );
        expect(ext.rowCount).toBe(0);
        const results = await Promise.allSettled(
          clients.map((c) => PostgresTrigramLexicalStore.create(c.db)),
        );
        expect(failures(results)).toEqual([]);
      });
    }
  }, 120_000);

  it("(b) pg_trgm も関数も既にある DB へ、別々の pool から同時に create() しても全部成功する", async () => {
    if (!(await isUtf8())) return;
    await withFreshDatabase(`${BASE}_b`, async (clients) => {
      await PostgresTrigramLexicalStore.create(clients[0]!.db);
      for (let round = 0; round < 15; round++) {
        const results = await Promise.allSettled(
          clients.map((c) => PostgresTrigramLexicalStore.create(c.db)),
        );
        expect(failures(results)).toEqual([]);
      }
    });
  }, 120_000);

  it("(c) 公開の probeTrigramLexicalSupport() の同時呼び出しも、全部 ok: true を返す", async () => {
    if (!(await isUtf8())) return;
    await withFreshDatabase(`${BASE}_c`, async (clients) => {
      const results = await Promise.allSettled(
        clients.map((c) => probeTrigramLexicalSupport(c.db)),
      );
      expect(failures(results)).toEqual([]);
      for (const r of results) {
        expect(r.status === "fulfilled" && r.value.ok).toBe(true);
      }
    });
  }, 120_000);

  it("(d) migrate の拡張を作る段（EXTENSION_LOCK_KEY）が握られている間は create() が待ち、放されたら成功する", async () => {
    if (!(await isUtf8())) return;
    await withFreshDatabase(`${BASE}_d`, async (clients) => {
      const holder = await clients[0]!.pool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1)", [EXTENSION_LOCK_KEY.toString()]);
        let settled = false;
        const pending = PostgresTrigramLexicalStore.create(clients[1]!.db).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(settled).toBe(false);
        await holder.query("SELECT pg_advisory_unlock($1)", [EXTENSION_LOCK_KEY.toString()]);
        await expect(pending).resolves.toBeInstanceOf(PostgresTrigramLexicalStore);
      } finally {
        holder.release();
      }
    });
  }, 120_000);
});
