import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture, DeterministicLLMProvider } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { killConnectionBeforeStatement, rejectStatement } from "./pool-fault-injection.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0444 BG-2: drizzle-orm 0.45.2 の `NodePgSession.transaction` は
 * `catch { await rollback; throw error }` で、`rollback` が投げると元のエラーを消す
 * （呼び出し側に `Failed query: rollback` しか残らない）。`createPostgresClient` が包んで、
 * `rollback` の失敗は握り、**元のエラー（`code` 付き）を優先して投げる**。`rollback` の失敗は
 * 元のエラーの `cause`（空いていれば）か `rollbackError` に残す。新しい例外の型は作らない。
 *
 * 直列の群に置く（`pg_terminate_backend`。`vitest.config.mts` の `SERIAL_TEST_FILES`）。
 */
describe("db.transaction(): rollback が失敗しても元のエラーを投げる（BG-2）", () => {
  let admin: PostgresClient;
  const victims: PostgresClient[] = [];
  beforeAll(async () => {
    await getTestClient();
    admin = createPostgresClient(requireDatabaseUrl(), { max: 2, application_name: "bg2-admin" });
  });
  afterAll(async () => {
    for (const v of victims) await Promise.race([closePostgresClient(v), sleep(2000)]);
    await closePostgresClient(admin);
    await closeTestClient();
  });

  function victim(applicationName: string): PostgresClient {
    const c = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: applicationName,
      onPoolError: () => {},
    });
    victims.push(c);
    return c;
  }

  it("本体が `code` 付きのエラーを投げ、そのあと rollback が失敗しても、投げられるのはその元のエラー", async () => {
    const client = victim("bg2-original");
    const original = Object.assign(new Error("元のエラー"), { code: "57P01" });
    const error: unknown = await client.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await admin.pool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
          ["bg2-original"],
        );
        await sleep(80);
        throw original;
      })
      .catch((e: unknown) => e);
    // 同じ例外オブジェクトのまま（型も作り替えない）。
    expect(error).toBe(original);
    expect((error as { code?: string }).code).toBe("57P01");
    // rollback の失敗は、元のエラーの cause に残る。
    const cause = (error as Error).cause as Error | undefined;
    expect(cause).toBeInstanceOf(Error);
    expect(String(cause?.message)).toMatch(/connection|terminat/i);
    expect(String(cause?.message)).not.toMatch(/already been released/i);
    expect(client.pool.totalCount - client.pool.idleCount).toBe(0);
  });

  it("本体の query が接続ごと切られ、rollback も失敗したとき、`Failed query: rollback` ではなく元の query の失敗（57P01）が届く", async () => {
    const client = victim("bg2-query");
    const error: unknown = await client.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_terminate_backend(pg_backend_pid())`);
      })
      .catch((e: unknown) => e);
    const e = error as Error & { cause?: Error & { code?: string } };
    expect(e).toBeInstanceOf(Error);
    expect(e.message).not.toMatch(/Failed query: rollback/i);
    expect(e.message).toMatch(/pg_terminate_backend/);
    expect(e.cause?.code).toBe("57P01");
    // rollback の失敗は cause が埋まっているので rollbackError に残る。
    expect(String((e as { rollbackError?: Error }).rollbackError?.message)).toMatch(
      /connection|terminat/i,
    );
    expect(client.pool.totalCount - client.pool.idleCount).toBe(0);
  });

  it("rollback が成功するふつうの失敗は、何も足さずにそのまま投げる", async () => {
    const client = victim("bg2-plain");
    const original = new Error("ふつうの失敗");
    const error: unknown = await client.db
      .transaction(async () => {
        throw original;
      })
      .catch((e: unknown) => e);
    expect(error).toBe(original);
    expect((error as Error).cause).toBeUndefined();
    expect("rollbackError" in (error as object)).toBe(false);
    // 接続は健全なまま pool に戻り、使い回せる。
    expect(client.pool.idleCount).toBe(1);
    await client.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
    });
  });

  it("rollback を握った接続は pool に戻らず、次の transaction は新しい接続で通る", async () => {
    const client = victim("bg2-discard");
    await client.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_terminate_backend(pg_backend_pid())`);
      })
      .catch(() => {});
    expect(client.pool.totalCount).toBe(0);
    await client.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
    });
    expect(client.pool.totalCount).toBe(1);
  });

  it("接続が生きたまま rollback だけが失敗したときも、その接続は pool に戻らず捨てられる（開いたままのトランザクションを次の借り手へ渡さない）", async () => {
    const app = "bg2-discard-alive";
    const client = victim(app);
    const original = new Error("元のエラー");
    const rollbackFailure = new Error("INJECTED: rollback failure");
    let pid = 0;
    const restore = rejectStatement({
      applicationName: app,
      matches: (text) => /^\s*rollback\s*;?\s*$/i.test(text),
      error: rollbackFailure,
      times: 1,
    });
    let error: unknown;
    try {
      error = await client.db
        .transaction(async (tx) => {
          const { rows } = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          pid = (rows[0] as { pid: number }).pid;
          throw original;
        })
        .catch((e: unknown) => e);
    } finally {
      restore();
    }
    expect(error).toBe(original);
    expect((error as Error).cause).toBe(rollbackFailure);
    expect(client.pool.totalCount).toBe(0);
    expect(client.pool.idleCount).toBe(0);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i += 1) {
      const { rows } = await admin.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [
        pid,
      ]);
      gone = rows.length === 0;
      if (!gone) await sleep(50);
    }
    expect(gone, "捨てたはずの接続の backend が残っている").toBe(true);
  });

  describe("forget / purge の outcomes[].error にも元のエラーが載る", () => {
    const ctx: Ctx = { tenantId: "transaction-rollback-error" };

    function runtimeOn(client: PostgresClient) {
      const memoryStore = new PostgresMemoryStore(client.db);
      const runtime = createRuntime({
        memoryStore,
        vectorStore: new PostgresVectorStore(client.db),
        eventStore: new PostgresEventStore(client.db),
        outboxStore: new PostgresOutboxStore(client.db),
        tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
        llmProvider: new DeterministicLLMProvider(),
        embeddingProvider: {
          space: TEST_EMBEDDING_SPACE,
          embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
        },
        hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
      });
      return { memoryStore, runtime };
    }

    async function seed(memoryStore: PostgresMemoryStore, hash: string) {
      return memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: hash,
          content: hash,
          digest: hash,
        }),
      );
    }

    it("forget: 更新の直前に接続が切られ、rollback も失敗しても、error に `Failed query: rollback` だけが残らない", async () => {
      await resetTestDatabase();
      const app = "bg2-forget";
      const client = victim(app);
      const { memoryStore, runtime } = runtimeOn(client);
      const m = await seed(memoryStore, "bg2-forget-1");
      const restore = killConnectionBeforeStatement({
        admin: admin.pool,
        applicationName: app,
        matches: (text) => /^\s*UPDATE memories\b/i.test(text),
      });
      let result;
      try {
        result = await runtime.forget(ctx, { memoryId: m.id });
      } finally {
        restore();
      }
      const outcome = result.outcomes[0]!;
      expect(outcome.kind).toBe("failed");
      const text = (outcome as { error: string }).error;
      expect(text).not.toMatch(/Failed query: rollback/i);
      expect(text).toMatch(/UPDATE memories/i);
      expect(text).toMatch(/connection|terminat/i);
    });

    it("purge: 同じく、error に元の失敗が載る", async () => {
      await resetTestDatabase();
      const app = "bg2-purge";
      const client = victim(app);
      const { memoryStore, runtime } = runtimeOn(client);
      const m = await seed(memoryStore, "bg2-purge-1");
      await runtime.forget(ctx, { memoryId: m.id });
      const restore = killConnectionBeforeStatement({
        admin: admin.pool,
        applicationName: app,
        matches: (text) => /^\s*UPDATE memories\b/i.test(text),
      });
      let result;
      try {
        result = await runtime.purge(ctx, { memoryId: m.id });
      } finally {
        restore();
      }
      const outcome = result.outcomes[0]!;
      expect(outcome.kind).toBe("failed");
      const text = (outcome as { error: string }).error;
      expect(text).not.toMatch(/Failed query: rollback/i);
      expect(text).toMatch(/UPDATE memories/i);
    });
  });
});
