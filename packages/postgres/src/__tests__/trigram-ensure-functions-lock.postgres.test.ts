import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  PostgresTrigramLexicalStore,
  ensureTrigramLexicalFunctions,
} from "../trigram-lexical-store.js";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { EXTENSION_LOCK_KEY, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

const DATABASE = "mnemora_trgm_ensure_fn_lock";

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

async function isUtf8(): Promise<boolean> {
  const { rows } = await admin().query<{ server_encoding: string }>("SHOW server_encoding");
  return rows[0]!.server_encoding.toUpperCase() === "UTF8";
}

describe("ensureTrigramLexicalFunctions を単体で呼ぶ経路", () => {
  it("拡張を作る段の lock が握られている間は終わらず、放されると終わる", async () => {
    if (!(await isUtf8())) return;
    await dropTempDatabase(admin(), DATABASE);
    await admin().query(`CREATE DATABASE ${DATABASE}`);
    const url = new URL(requireDatabaseUrl());
    url.pathname = `/${DATABASE}`;
    const holderClient = createPostgresClient(url.toString());
    const callerClient = createPostgresClient(url.toString());
    try {
      await runMigrations(holderClient.pool);
      await PostgresTrigramLexicalStore.create(holderClient.db);
      const holder = await holderClient.pool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1)", [EXTENSION_LOCK_KEY.toString()]);
        let settled = false;
        const pending = ensureTrigramLexicalFunctions(callerClient.db).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(settled).toBe(false);
        await holder.query("SELECT pg_advisory_unlock($1)", [EXTENSION_LOCK_KEY.toString()]);
        await expect(pending).resolves.toBeUndefined();
      } finally {
        holder.release();
      }
    } finally {
      await closePostgresClient(holderClient);
      await closePostgresClient(callerClient);
      await dropTempDatabase(admin(), DATABASE);
    }
  }, 120_000);
});
