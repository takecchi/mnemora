import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { EXTENSION_LOCK_KEY, MigrationLockTimeoutError, runMigrations } from "../migrate.js";
import {
  createOptionalTrigramIndex,
  ensureTrigramLexicalFunctions,
  probeTrigramLexicalSupport,
  TRIGRAM_NOISE_STOPWORD_PATTERN,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";

/**
 * TSDoc の5巡目の調査で、約束どおりに動くがどのテストも縛っていなかった振る舞いを縛る
 * （B1 の postgres の側、B6・B7・B8）。今の振る舞いの固定であり、望ましい姿の主張ではない。
 */

afterAll(async () => {
  const { pool } = await getTestClient();
  await pool.query("DROP INDEX IF EXISTS idx_memories_trigram");
  await closeTestClient();
});

describe("purgeExpiredEvents: 表せる最も古い Date を渡しても例外にならない（B1 の postgres の側）", () => {
  it("purgeExpiredEventsForTenant が巨大な日数で寄せる先（-8.64e15 ms）を olderThan に渡すと、0件で返る", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx = { tenantId: `tsdoc-5th-purge-${randomUUID()}` };
    await store.createMemory(ctx, buildNewMemoryFixture({}));
    const result = await store.purgeExpiredEvents!(ctx, {
      olderThan: new Date(-8.64e15),
      limit: 10,
    });
    expect(result).toMatchObject({ purged: 0, reachedLimit: false });
  });
});

describe("trigram の下ごしらえ（B6・B7）", () => {
  it("B6: ensureTrigramLexicalFunctions と createOptionalTrigramIndex は2回続けて呼んでも通り、索引は1本だけ", async () => {
    const { db, pool } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      expect(probe.reason).toBe("server_encoding_not_utf8");
      return;
    }
    await ensureTrigramLexicalFunctions(db);
    await ensureTrigramLexicalFunctions(db);
    await createOptionalTrigramIndex(db);
    await createOptionalTrigramIndex(db);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_memories_trigram'",
    );
    expect(rows[0]!.n).toBe(1);
    const fns = await pool.query<{ proname: string; n: number }>(
      `SELECT proname, count(*)::int AS n FROM pg_proc
        WHERE proname IN ('mnemora_trigram_query_nonascii', 'mnemora_trigram_strip_noise', 'mnemora_trigram_hybrid_coverage')
        GROUP BY proname ORDER BY proname`,
    );
    expect(fns.rows).toEqual([
      { proname: "mnemora_trigram_hybrid_coverage", n: 1 },
      { proname: "mnemora_trigram_query_nonascii", n: 1 },
      { proname: "mnemora_trigram_strip_noise", n: 1 },
    ]);
  });

  it("B7: TRIGRAM_NOISE_STOPWORD_PATTERN は、入った mnemora_trigram_strip_noise の本体の選言そのものであり、その語尾を削る", async () => {
    const { db, pool } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      expect(probe.reason).toBe("server_encoding_not_utf8");
      return;
    }
    await ensureTrigramLexicalFunctions(db);
    const { rows } = await pool.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE proname = 'mnemora_trigram_strip_noise'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prosrc).toContain(`'(${TRIGRAM_NOISE_STOPWORD_PATTERN})'`);
    const stripped = await pool.query<{ s: string | null }>(
      "SELECT mnemora_trigram_strip_noise('京都の予定ですか') AS s",
    );
    expect(stripped.rows[0]!.s).toBe("京都の予定");
  });
});

describe("runMigrations の lockTimeoutMs と lockKey（B8。別のセッションが共有の拡張ロックを握った状態）", () => {
  /** 新しいスキーマへ当てると、0001 の CREATE EXTENSION の段を通るので、共有の拡張ロックを取りに行く。 */
  async function withFreshSchema(fn: (schema: string, pool: Pool) => Promise<void>): Promise<void> {
    const schema = `tsdoc5th_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 3 });
    try {
      await fn(schema, pool);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  }

  /** `key` を別のセッションで握り、`fn` の後に離す。 */
  async function holding(key: bigint, fn: () => Promise<void>): Promise<void> {
    const holder = new Client({ connectionString: requireDatabaseUrl() });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [key.toString()]);
    try {
      await fn();
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [key.toString()]);
      await holder.end();
    }
  }

  /** 5秒で締め切る（既定の lockTimeoutMs は30秒なので、効いていなければここで分かる）。 */
  async function settleWithin(
    promise: Promise<unknown>,
    ms: number,
  ): Promise<{ settled: boolean; error?: unknown }> {
    const outcome = promise.then(
      () => ({ settled: true }),
      (error: unknown) => ({ settled: true, error }),
    );
    const timeout = new Promise<{ settled: boolean }>((resolve) =>
      setTimeout(() => resolve({ settled: false }), ms),
    );
    return Promise.race([outcome, timeout]);
  }

  it("lockTimeoutMs は共有の拡張ロックにも効き、lockKey を上書きしても共有の拡張ロックは差し替わらない", async () => {
    await getTestClient(); // 既定の public は適用済みにしておく（ここでは新しいスキーマだけを見る）
    await withFreshSchema(async (schema, pool) => {
      let pending: Promise<unknown> | undefined;
      await holding(EXTENSION_LOCK_KEY, async () => {
        const started = Date.now();
        pending = runMigrations(pool, undefined, {
          schema,
          lockTimeoutMs: 300,
          // 誰も握っていない schema ごとのロックのキー。これで共有の拡張ロックが差し替わるなら、待たずに通ってしまう。
          lockKey: 900_000_000_000_000_001n,
        });
        const { settled, error } = await settleWithin(pending, 5000);
        expect(settled, "lockTimeoutMs が共有の拡張ロックに効いていない（5秒で決着しない）").toBe(
          true,
        );
        expect(error).toBeInstanceOf(MigrationLockTimeoutError);
        expect(Date.now() - started).toBeLessThan(5000);
      });
      await pending?.catch(() => undefined);
    });
  });

  it("陽性対照: 共有の拡張ロックを誰も握っていなければ、同じ呼び出しは通る", async () => {
    await withFreshSchema(async (schema, pool) => {
      const { applied } = await runMigrations(pool, undefined, {
        schema,
        lockTimeoutMs: 300,
        lockKey: 900_000_000_000_000_001n,
      });
      expect(applied.length).toBeGreaterThan(0);
    });
  });

  it("lockKey は schema ごとのロックのキーになる（そのキーを握られると、lockTimeoutMs で止まる）", async () => {
    await withFreshSchema(async (schema, pool) => {
      const key = 900_000_000_000_000_002n;
      await holding(key, async () => {
        const pending = runMigrations(pool, undefined, {
          schema,
          lockTimeoutMs: 300,
          lockKey: key,
        });
        const { settled, error } = await settleWithin(pending, 5000);
        expect(settled).toBe(true);
        expect(error).toBeInstanceOf(MigrationLockTimeoutError);
      });
    });
  });
});
