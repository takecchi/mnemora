import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresClient, closePostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";

/**
 * `schema-namespace.ts` の TSDoc は、「同梱の呼び出し（`runMigrations`・`registerEmbeddingSpace`・
 * `createPostgresClient` など）は、どれも先に検査（`assertSafeSchemaName`）を通してから呼んでいる」と約束している。
 * `registerEmbeddingSpace` の門は `register-embedding-space-unsafe-schema.postgres.test.ts` が縛っている。
 * ここは残りの2つ、`runMigrations` と `createPostgresClient` の門を、DB に繋がずに縛る。
 *
 * 門が消えると、安全でない名前は二重引用符の中へ（`CREATE SCHEMA`）、または接続オプション
 * （`-c search_path=...`）へそのまま入る。後者は空白で別の設定として読まれうる。
 * 見るのは「`assertSafeSchemaName` の message で投げる」ことと、
 * 「投げる前に DB へ何も発行しない・接続を作らない」こと。
 */

const BAD_SCHEMA = 'Bad"x';
const BAD_EXTENSION_SCHEMA = "Bad x";
const UNSAFE = /^unsafe SQL identifier: /;

/** `runMigrations` が発行した SQL を記録するだけの偽の `Pool`。 */
function createRecordingPool(): { pool: Pool; log: string[]; connectCount: () => number } {
  const log: string[] = [];
  let connects = 0;
  // 陽性対照が最後まで進めるよう、pgvector の能力検査（`pg_settings`）には「対応している」行を返す。
  const respond = (text: string): { rows: unknown[] } =>
    text.includes("pg_settings")
      ? { rows: [{ extversion: "0.8.0", vartype: "enum", enumvals: ["off", "relaxed_order"] }] }
      : { rows: [] };
  const client = {
    query: async (text: string) => {
      log.push(`client.query: ${text}`);
      return respond(text);
    },
    release: () => {},
    on: () => client,
    removeListener: () => client,
  };
  const pool = {
    query: async (text: string) => {
      log.push(`pool.query: ${text}`);
      return respond(text);
    },
    connect: async () => {
      connects += 1;
      return client;
    },
  };
  return { pool: pool as unknown as Pool, log, connectCount: () => connects };
}

async function thrownOf(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  await run().catch((e: unknown) => {
    thrown = e;
  });
  return thrown;
}

describe("runMigrations: 安全でない schema・extensionSchema は、DB に触れる前に assertSafeSchemaName の Error で断る", () => {
  it("安全でない schema は断り、CREATE SCHEMA を発行せず、接続も借りない", async () => {
    const { pool, log, connectCount } = createRecordingPool();
    const thrown = await thrownOf(() => runMigrations(pool, undefined, { schema: BAD_SCHEMA }));
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(UNSAFE);
    expect(log).toEqual([]);
    expect(connectCount()).toBe(0);
  });

  it("schema が安全でも、安全でない extensionSchema は断り、DB に触れない", async () => {
    const { pool, log, connectCount } = createRecordingPool();
    const thrown = await thrownOf(() =>
      runMigrations(pool, undefined, {
        schema: "some_schema",
        extensionSchema: BAD_EXTENSION_SCHEMA,
      }),
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(UNSAFE);
    expect(log).toEqual([]);
    expect(connectCount()).toBe(0);
  });

  it("陽性対照: 安全な schema なら CREATE SCHEMA まで進む", async () => {
    const { pool, log } = createRecordingPool();
    await runMigrations(pool, undefined, { schema: "some_schema" });
    expect(log.some((entry) => /CREATE SCHEMA/.test(entry))).toBe(true);
  });
});

describe("createPostgresClient: 安全でない schema・extensionSchema は、接続オプションを組む前に assertSafeSchemaName の Error で断る", () => {
  // 門が消えても pool は遅延接続なので、返ってきたときは後始末だけして、呼び出し側には「投げなかった」を見せる。
  async function createOrThrow(
    config: Parameters<typeof createPostgresClient>[1],
  ): Promise<unknown> {
    let client: PostgresClient | undefined;
    try {
      client = createPostgresClient("postgres://user@127.0.0.1:1/none", config);
      return undefined;
    } catch (e) {
      return e;
    } finally {
      if (client) await closePostgresClient(client);
    }
  }

  it("安全でない schema は断る", async () => {
    const thrown = await createOrThrow({ schema: "Bad x" });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(UNSAFE);
  });

  it("schema が安全でも、安全でない extensionSchema は断る", async () => {
    const thrown = await createOrThrow({
      schema: "some_schema",
      extensionSchema: BAD_EXTENSION_SCHEMA,
    });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(UNSAFE);
  });

  it("陽性対照: 安全な schema・extensionSchema なら投げない", async () => {
    const thrown = await createOrThrow({ schema: "some_schema", extensionSchema: "ext_schema" });
    expect(thrown).toBeUndefined();
  });
});
