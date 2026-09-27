import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import * as postgres from "../index.js";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { runMigrations } from "../migrate.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `@mnemora/postgres` の options を省いたときの既定値が、TSDoc・CLI の説明・README に書かれた値と一致することを縛る。
 * **doc の値はソースと README を実行時に読んで**（`{@link DEFAULT_…}` で定数を指している欄は、その定数を公開の入口から
 * 解決して）、**実装の値は options を省いたときの振る舞いから**取って突き合わせる。
 * 対象は `extensionMode`・`extensionSchema`・`lockTimeoutMs`（`runMigrations` と `registerEmbeddingSpace`）と、
 * trigram の store の閾値（`DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD`）。
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const MIGRATE = read("../migrate.ts");
const VECTOR_SPACE = read("../vector-space.ts");
const SCHEMA_NAMESPACE = read("../schema-namespace.ts");
const CLI_OPTIONS = read("../bin/cli-options.ts");
const README = read("../../README.md");

/** `interface <name> … {` の中で、`field?:` の直前の TSDoc を返す。 */
function docOf(source: string, interfaceName: string, field: string): string {
  const start = source.indexOf(`export interface ${interfaceName} `);
  const end = source.indexOf("\n}\n", start);
  const block = source.slice(start, end);
  const at = block.indexOf(`\n  ${field}?:`);
  if (start < 0 || at < 0) throw new Error(`${interfaceName}.${field} が見つからない`);
  return block.slice(block.lastIndexOf("/**", at), at);
}

/** doc が `{@link NAME}` で指す定数を、公開の入口（`../index.js`）から解決する。 */
function linkedDefault(doc: string): unknown {
  const m = doc.match(/既定は\s*\{@link\s+([A-Z0-9_]+)\}/);
  if (!m) throw new Error(`既定の {@link} が見つからない: ${doc}`);
  const value = (postgres as Record<string, unknown>)[m[1]!];
  if (value === undefined) throw new Error(`${m[1]} は公開されていない`);
  return value;
}

/** `pool.connect()` で借りた接続に流れたクエリの `set_config('lock_timeout', $1, …)` の値を集める。 */
function recordLockTimeouts(pool: Pool): string[] {
  const values: string[] = [];
  const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  // `pool.query` は内部で `connect(callback)` を呼ぶ——コールバックつきの呼び出しは元のまま通す。
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (
    ...args: unknown[]
  ) => {
    if (args.length > 0) return original(...args);
    return (original() as Promise<PoolClient>).then((client) => {
      const query = client.query.bind(client) as (...qargs: unknown[]) => unknown;
      (client as unknown as { query: (...qargs: unknown[]) => unknown }).query = (
        ...qargs: unknown[]
      ) => {
        const [text, params] = qargs as [unknown, unknown[] | undefined];
        if (typeof text === "string" && text.includes("set_config('lock_timeout', $1") && params) {
          values.push(String(params[0]));
        }
        return query(...qargs);
      };
      return client;
    });
  };
  return values;
}

const ctx: Ctx = { tenantId: "postgres-defaults-doc" };

afterAll(async () => {
  await closeTestClient();
});

describe("@mnemora/postgres の既定値は doc の値と一致する", () => {
  it("runMigrations の extensionMode（既定 create）と lockTimeoutMs", async () => {
    await resetTestDatabase();
    await getTestClient();
    const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
    expect(docOf(MIGRATE, "RunMigrationsOptions", "extensionMode")).toMatch(/既定は\s*`"create"`/);
    expect(README).toMatch(/`extensionMode: "create"`（既定）/);
    expect(CLI_OPTIONS).toMatch(/create（既定）/);

    try {
      const lockTimeouts = recordLockTimeouts(pool);
      const result = await runMigrations(pool);
      // `extensionMode: "create"` の経路では extensionCheck が載らない（`RunMigrationsResult.extensionCheck` の doc）。
      expect(result.extensionCheck).toBeUndefined();
      expect(lockTimeouts[0]).toBe(
        String(linkedDefault(docOf(MIGRATE, "RunMigrationsOptions", "lockTimeoutMs"))),
      );
    } finally {
      await pool.end();
    }
  });

  it("registerEmbeddingSpace の lockTimeoutMs", async () => {
    await resetTestDatabase();
    await getTestClient();
    const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
    try {
      const lockTimeouts = recordLockTimeouts(pool);
      await registerEmbeddingSpace(pool, {
        provider: "test",
        model: "defaults-doc",
        dimensions: 3,
      });
      expect(lockTimeouts[0]).toBe(
        String(
          linkedDefault(docOf(VECTOR_SPACE, "RegisterEmbeddingSpaceOptions", "lockTimeoutMs")),
        ),
      );
    } finally {
      await pool.end();
    }
  });

  it("createPostgresClient の extensionSchema（schema を渡したときの search_path）", async () => {
    const documented = linkedDefault(
      docOf(SCHEMA_NAMESPACE, "SchemaNamespaceOptions", "extensionSchema"),
    );
    expect(CLI_OPTIONS).toMatch(new RegExp(`省略時は "${String(documented)}"`));
    const client = createPostgresClient(requireDatabaseUrl(), { schema: "defaults_doc" });
    try {
      const options = (client.pool as unknown as { options: { options?: string } }).options.options;
      expect(options).toBe(`-c search_path=defaults_doc,${String(documented)}`);
    } finally {
      await closePostgresClient(client);
    }
  });

  it("PostgresTrigramLexicalStore の閾値（threshold を省いたとき、word_similarity が既定の閾値以上の本文だけを返す）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      expect(probe.reason).toBe("server_encoding_not_utf8");
      return;
    }
    const store = await PostgresTrigramLexicalStore.create(db);
    const threshold = postgres.DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD;
    const query = "会議に参加します";
    const contents = [
      "会議に参加",
      "会議に出る",
      "会議の日",
      "会議室で待つ",
      "まったく関係の無い文",
    ];
    const memoryStore = new PostgresMemoryStore(db);
    const idOf = new Map<string, string>();
    for (const content of contents) {
      const m = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: content, content }),
      );
      idOf.set(m.id, content);
    }
    const { rows } = await pool.query<{ c: string; ws: number }>(
      `SELECT c, word_similarity(mnemora_trigram_strip_noise(mnemora_trigram_query_nonascii($1)), c) AS ws
       FROM unnest($2::text[]) AS c`,
      [query, contents],
    );
    const above = rows.filter((r) => r.ws >= threshold).map((r) => r.c);
    // 境目の両側に本文があること（歯が閾値そのものを見ていること）を先に確かめる。
    expect(rows.some((r) => r.ws >= threshold && r.ws < threshold + 0.15)).toBe(true);
    expect(rows.some((r) => r.ws < threshold && r.ws > threshold - 0.15)).toBe(true);

    const hits = await store.search(ctx, query, {
      limit: 10,
      filter: { tenantId: ctx.tenantId, status: ["active", "contested"] },
    });
    expect(hits.map((h) => idOf.get(h.memoryId)).sort()).toEqual([...above].sort());
  });
});
