import { sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import type { Db } from "../client.js";
import {
  createOptionalTrigramIndex,
  createOptionalTrigramIndexConcurrently,
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `createOptionalTrigramIndexConcurrently`（`idx_memories_trigram` を `CREATE INDEX CONCURRENTLY` で
 * 張る版）が、素の版 `createOptionalTrigramIndex` と何が違い、何が同じかを実行時に固定する。
 *
 * 1. 素の版は `memories` に `ShareLock` を取り、並行する `INSERT` は待たされる。
 *    `CONCURRENTLY` 版は `ShareUpdateExclusiveLock` を取り、`INSERT` は通る。
 * 2. どちらで作っても `pg_get_indexdef` が同じになる。
 * 3. `indisvalid = false` の索引が残っていても、`CONCURRENTLY` 版は作り直して VALID にする。
 *
 * ## `pg_locks` は自分の DB に絞る
 *
 * `pg_locks` はクラスタ全体のロックが見える。`database = (SELECT oid FROM pg_database WHERE
 * datname = current_database())` で、worker ごとの別 DB のロックを拾わないようにする。
 * この歯は `pg_locks` を読むので `vitest.config.mts` の `SERIAL_TEST_FILES`（直列群）に入れてある。
 *
 * ## `CONCURRENTLY` 中のロックを見る方法（`pg_sleep` を使わない）
 *
 * `CREATE INDEX CONCURRENTLY` は、`memories` に `RowExclusiveLock` 以上を持つ未完了の
 * トランザクションが居る間、最初の待ちで止まる。そこで接続 H が `BEGIN` → `INSERT`
 * （`RowExclusiveLock` を保持）したまま、別接続で `CONCURRENTLY` 版を走らせると、索引作成は
 * 「実行中」のまま止まる。その間に `pg_locks` から作成側の pid のロックを読み、別接続の
 * `INSERT` が通ることを確かめ、最後に H を `ROLLBACK` して作成を完了させる。
 *
 * ## INVALID な索引の作り方（キャンセル）
 *
 * 上の待ちの最中に `statement_timeout` で `CONCURRENTLY` をキャンセルする。索引の catalog 行は
 * 最初のトランザクションで確定済みなので、`indisvalid = false` の `idx_memories_trigram` が残る
 * ——実運用で失敗・中断したときに残るのと同じ経路である。`UPDATE pg_index SET indisvalid = false`
 * で偽造しない理由は、catalog の直接更新には superuser が要り、しかも実際の失敗の残り方
 * （`indisready` など他の列）と食い違いうるため。
 */

const TENANT = "trigram-concurrently-tenant";
const INDEX_NAME = "idx_memories_trigram";

const PG_LOCKS_OF_PID = `
  SELECT mode, granted FROM pg_locks
   WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND relation = 'memories'::regclass
     AND locktype = 'relation'
     AND pid = $1`;

afterAll(async () => {
  const { pool } = await getTestClient();
  await pool.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await closeTestClient();
});

async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}

/** `memories` に1行足す（`RowExclusiveLock` を取る書き込み）。 */
async function insertOne(client: Pool | PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO memories (
       id, tenant_id, subject_id, content, content_hash, digest, digest_source,
       provenance_kind, provenance, status, tags, occurred_at, recorded_at,
       last_reinforced_at, strength, half_life_hours, decay_floor_at,
       embedding_status, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1, NULL, '田中さんが会議に参加します', md5(random()::text), 'digest', 'llm',
       'imported', '{"kind":"imported","batchId":"fixture-batch"}'::jsonb, 'active',
       '{}', NULL, now(), NULL, 1.0, 720, now() + interval '30 days', 'ready', now(), now()
     )`,
    [TENANT],
  );
}

async function indexState(pool: Pool): Promise<{ valid: boolean; def: string } | undefined> {
  const { rows } = await pool.query<{ valid: boolean; def: string }>(
    `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'memories'::regclass AND c.relname = $1`,
    [INDEX_NAME],
  );
  return rows[0];
}

/** 走行中の `CREATE INDEX`（`CONCURRENTLY` 付きか否かは問わず。外した変異でも backend を見つけ、ロックの assertion で落とすため）を実行している自DBの backend の pid が出るまで待つ。 */
async function waitForConcurrentBuildPid(pool: Pool): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND btrim(query, E' \n\t') ILIKE 'CREATE INDEX%'
          AND state = 'active'`,
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("CREATE INDEX CONCURRENTLY の backend が見つからなかった");
}

let supported = false;

beforeEach(async () => {
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const probe = await probeTrigramLexicalSupport(db);
  supported = probe.ok;
  if (probe.ok) await PostgresTrigramLexicalStore.create(db);
  await pool.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
});

describe("createOptionalTrigramIndex(Concurrently) が memories に取るロック", () => {
  it("素の版は ShareLock を取り、並行する INSERT は短い statement_timeout で止まる", async () => {
    if (!supported) return;
    const { db } = await getTestClient();
    // 素の版はトランザクションの中でも走る。COMMIT 前（コールバックの中）なら ShareLock が保持されたまま。
    // tx は Db と型が違うだけで、既存関数は db.execute しか使わない。
    await db.transaction(async (tx) => {
      await createOptionalTrigramIndex(tx as unknown as Db);

      const result = await tx.execute(sql.raw(PG_LOCKS_OF_PID.replace("$1", "pg_backend_pid()")));
      const modes = (result.rows as { mode: string }[]).map((r) => r.mode);
      expect(modes).toContain("ShareLock");
      expect(modes).not.toContain("AccessExclusiveLock");

      const writer = createPostgresClient(requireDatabaseUrl(), {
        options: "-c statement_timeout=300",
        max: 1,
      });
      try {
        await expect(insertOne(writer.pool)).rejects.toMatchObject({ code: "57014" });
      } finally {
        await closePostgresClient(writer).catch(() => {});
      }
    });
  }, 15_000);

  it("CONCURRENTLY 版は ShareUpdateExclusiveLock を取り、並行する INSERT は通る", async () => {
    if (!supported) return;
    const { db, pool } = await getTestClient();
    const holder = await pool.connect();
    let build: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      await insertOne(holder);

      build = createOptionalTrigramIndexConcurrently(db);
      const pid = await waitForConcurrentBuildPid(pool);

      const { rows } = await pool.query<{ mode: string; granted: boolean }>(PG_LOCKS_OF_PID, [pid]);
      const granted = rows.filter((r) => r.granted).map((r) => r.mode);
      expect(granted).toContain("ShareUpdateExclusiveLock");
      expect(granted).not.toContain("ShareLock");
      expect(granted).not.toContain("AccessExclusiveLock");

      const write = insertOne(pool);
      expect(await settlesWithin(write, 2000)).toBe(true);
      await write;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await build; // H を放したので、索引作成が完了する
    }
    expect((await indexState(pool))?.valid).toBe(true);
  }, 30_000);
});

describe("createOptionalTrigramIndexConcurrently の索引の定義と再作成", () => {
  it("素の版と CONCURRENTLY 版で pg_get_indexdef が同じになる", async () => {
    if (!supported) return;
    const { db, pool } = await getTestClient();
    await createOptionalTrigramIndex(db);
    const plain = await indexState(pool);
    expect(plain?.valid).toBe(true);
    await pool.query(`DROP INDEX ${INDEX_NAME}`);

    await createOptionalTrigramIndexConcurrently(db);
    const concurrent = await indexState(pool);
    expect(concurrent?.valid).toBe(true);
    expect(concurrent?.def).toBe(plain?.def);
    expect(concurrent?.def).toContain("gin (tenant_id, content gin_trgm_ops)");
    expect(concurrent?.def).toMatch(/WHERE.*status.*active.*contested/);

    await createOptionalTrigramIndexConcurrently(db);
    expect(await indexState(pool)).toEqual(concurrent);
  }, 30_000);

  it("INVALID な索引が残っていれば DROP して作り直し、VALID かつ同じ定義になる", async () => {
    if (!supported) return;
    const { db, pool } = await getTestClient();
    await createOptionalTrigramIndex(db);
    const expectedDef = (await indexState(pool))?.def;
    await pool.query(`DROP INDEX ${INDEX_NAME}`);

    const holder = await pool.connect();
    const victim = createPostgresClient(requireDatabaseUrl(), {
      options: "-c statement_timeout=500",
      max: 1,
    });
    try {
      await holder.query("BEGIN");
      await insertOne(holder);
      await expect(
        victim.pool.query(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
             ON memories USING gin (tenant_id, content gin_trgm_ops)
             WHERE status IN ('active', 'contested')`,
        ),
      ).rejects.toMatchObject({ code: "57014" });
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await closePostgresClient(victim).catch(() => {});
    }
    // 前提: 実際に INVALID が残っている（残っていなければこの歯は何も見ていない）。
    expect((await indexState(pool))?.valid).toBe(false);

    await createOptionalTrigramIndexConcurrently(db);

    const after = await indexState(pool);
    expect(after?.valid).toBe(true);
    expect(after?.def).toBe(expectedDef);
  }, 30_000);
});
